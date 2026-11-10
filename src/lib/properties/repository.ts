import { appendAudit } from '@/lib/audit';
import { parseStoredEquipment } from '@/lib/equipment';
import { newUlid } from '@/lib/pg/ulid';
import type { OrgTx } from '@/lib/pg/with-tx';
import { normalizeAddress } from '@/lib/registry/address-match';
import { formatDisplayCode } from '@/lib/registry/display-code';
import { sectionLabel } from '@/lib/registry/section-code';
import type { AnchorKey } from '@/lib/registry/section-code';
import type { Property, PropertyAnchor, PropertyType, PropertyUnit, RentalUnitStatus, RentalUnitType, SiblingUnit } from '@/lib/types';
import { claimAnchorKey } from './collision';
import { hasActiveLeaseForProperty, hasCasesForProperty } from './contract-links';
import type { PropertyInput } from './input';
import type { SubletInput } from './sublet';
import { ensureNames } from './vocabulary';

// 物件的 repository（MIL-81）。這是之後各實體 repository 的範本：
// - 第一個參數是 withTx 給的 tx，型別 OrgTx，傳 control 的 tx 會讓 tsc 報錯。
// - 不傳 org_id：INSERT 取交易的 app.org_id，查詢靠 RLS 篩選。別的組織的列和不存在的列沒有差別。
// - ID 由這裡用 newUlid() 產生，呼叫端拿到的永遠是 ULID。
// - 建物件時同一個交易經 registry 函式建待驗證錨點與 0000 單位（P0-06 AC5）。

interface Row {
  id: string;
  rental_unit_id: string;
  name: string;
  address: string;
  type: PropertyType;
  size: number | null;
  default_rent: number | null;
  note: string;
  equipment: unknown;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date | null;
}

const COLUMNS =
  'id, rental_unit_id, name, address, type, size, default_rent, note, equipment, archived_at, created_at, updated_at';

/** 物件已合併或停用，不能修正建號。通過核對後要送審核台的規則等核對功能（MIL-201）加入後再處理。 */
export class AnchorKeyLockedError extends Error {
  constructor() {
    super('物件目前不能修正建號');
  }
}
/** DB 端的鍵檢查沒過（段碼表與 seed 不同步、建號格式）。純函式已先驗過，所以正常不會發生。 */
export class AnchorKeyRejectedError extends Error {}

function rethrowAnchorError(error: unknown): never {
  const { code, message } = error as { code?: string; message?: string };
  if (code === '55000') throw new AnchorKeyLockedError();
  if (code === '22023') throw new AnchorKeyRejectedError(message);
  throw error;
}

interface AnchorRow {
  unit_id: string;
  anchor_id: string;
  /** 內部狀態。對外的狀態只由文件核對決定，這個欄位不得進回應。 */
  status: string;
  city_code: string | null;
  town_code: string | null;
  section_code: string | null;
  building_no: string | null;
  sub_no: string | null;
  city_name: string | null;
  town_name: string | null;
  section_name: string | null;
  section_sub_name: string | null;
  latitude: number | null;
  longitude: number | null;
}

interface UnitAnchor {
  anchorId: string;
  anchor: PropertyAnchor;
}

/**
 * 讀租賃單位所屬物件的建號。registry 只能經函式讀，函式只回呼叫者組織有物件指向的單位。
 * 鍵撞到別的組織時，函式回傳呼叫者宣稱的鍵，所以這裡看不出撞號。AnchorRow.status 是內部狀態，不得複製到回傳值。
 */
async function fetchAnchors(tx: OrgTx, unitIds: string[]): Promise<Map<string, UnitAnchor>> {
  if (unitIds.length === 0) return new Map();
  const { rows } = await tx.query<AnchorRow>('SELECT * FROM registry.get_anchors_for_units($1::text[])', [unitIds]);
  return new Map(
    rows.map((r) => [
      r.unit_id,
      {
        anchorId: r.anchor_id,
        anchor: {
          city_code: r.city_code,
          town_code: r.town_code,
          section_code: r.section_code,
          building_no: r.building_no,
          sub_no: r.sub_no,
          city_name: r.city_name,
          town_name: r.town_name,
          section_name: r.section_name === null ? null : sectionLabel({ name: r.section_name, subName: r.section_sub_name ?? '' }),
          latitude: r.latitude,
          longitude: r.longitude,
        },
      },
    ]),
  );
}

/** 讀一個租賃單位的錨點。讀不到（單位不是呼叫者組織的）回 undefined。 */
async function fetchUnitAnchor(tx: OrgTx, unitId: string): Promise<UnitAnchor | undefined> {
  return (await fetchAnchors(tx, [unitId])).get(unitId);
}

interface UnitRow {
  unit_id: string;
  suffix: string;
  label: string | null;
  floor: string | null;
  unit_type: RentalUnitType;
  status: RentalUnitStatus;
  display_unit_id: string;
  display_city_code: string | null;
  display_town_code: string | null;
}

/**
 * 顯示編碼（ADR-0025 決議 12）。被合併的單位用存續單位的 ID 與錨點。
 * 待驗證的錨點沒有縣市與鄉鎮編碼，回 null。
 */
function displayCodeOf(row: UnitRow): string | null {
  if (!row.display_city_code || !row.display_town_code) return null;
  return formatDisplayCode({ countyLetter: row.display_city_code, townCode: row.display_town_code, rentalUnitId: row.display_unit_id });
}

const isoOrNull = (value: Date | null): string | null => (value ? value.toISOString() : null);

function toUnit(row: UnitRow): PropertyUnit {
  return {
    suffix: row.suffix,
    label: row.label,
    floor: row.floor,
    unit_type: row.unit_type,
    status: row.status,
    display_code: displayCodeOf(row),
  };
}

/** 讀租賃單位摘要與顯示編碼。registry 只能經函式讀，函式只回呼叫者組織有物件指向的單位。 */
async function fetchUnits(tx: OrgTx, unitIds: string[]): Promise<Map<string, PropertyUnit>> {
  if (unitIds.length === 0) return new Map();
  const { rows } = await tx.query<UnitRow>('SELECT * FROM registry.get_unit_details($1::text[])', [unitIds]);
  return new Map(rows.map((r) => [r.unit_id, toUnit(r)]));
}

function toProperty(row: Row, anchor: PropertyAnchor | null, unit: PropertyUnit | null): Property {
  return {
    id: row.id,
    rental_unit_id: row.rental_unit_id,
    unit,
    archived_at: isoOrNull(row.archived_at),
    anchor,
    // 對外狀態只由文件核對決定，不讀 registry.anchors.status。核對功能（MIL-201）加入前，每個物件都在等平台核對文件
    verification_status: 'pending_verification',
    name: row.name,
    address: row.address,
    type: row.type,
    size: row.size,
    default_rent: row.default_rent,
    note: row.note,
    equipment: parseStoredEquipment(row.equipment),
    created_at: row.created_at.toISOString(),
    updated_at: isoOrNull(row.updated_at),
  };
}

/** 新的在前。ULID 隨時間遞增，所以 id DESC 就是建立時間由新到舊。 */
export async function listProperties(tx: OrgTx): Promise<Property[]> {
  const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM org.properties ORDER BY id DESC`);
  const unitIds = rows.map((r) => r.rental_unit_id);
  const anchors = await fetchAnchors(tx, unitIds);
  const units = await fetchUnits(tx, unitIds);
  return rows.map((r) => toProperty(r, anchors.get(r.rental_unit_id)?.anchor ?? null, units.get(r.rental_unit_id) ?? null));
}

export async function getProperty(tx: OrgTx, id: string): Promise<Property | null> {
  const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM org.properties WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  const unitId = rows[0].rental_unit_id;
  return toProperty(rows[0], (await fetchUnitAnchor(tx, unitId))?.anchor ?? null, (await fetchUnits(tx, [unitId])).get(unitId) ?? null);
}

export type RegisterPropertyResult =
  /** 物件已建立。鍵有沒有撞到別的組織，這裡看不出來（ADR-0028 決議 1）。 */
  | { kind: 'created'; id: string }
  /** 鍵已被自己組織登錄。什麼都沒建，id 是自己既有的物件。 */
  | { kind: 'existing'; id: string };

/** 建立物件的列：設備詞彙、待驗證錨點與 0000 單位、物件。不寫稽核，也不處理鍵。 */
async function insertPropertyRows(tx: OrgTx, input: PropertyInput): Promise<{ id: string; anchorId: string; unitId: string }> {
  await ensureNames(tx, input.equipment.map((i) => i.name));

  const anchorId = newUlid();
  const unitId = newUlid();
  await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3, $4, $5, $6)', [
    anchorId,
    unitId,
    input.address,
    normalizeAddress(input.address).normalized,
    input.anchor?.latitude ?? null,
    input.anchor?.longitude ?? null,
  ]);

  const id = newUlid();
  await tx.query(
    `INSERT INTO org.properties (id, org_id, rental_unit_id, name, address, type, size, default_rent, note, equipment)
     VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      id,
      unitId,
      input.name,
      input.address,
      input.type ?? '整層住家',
      input.size,
      input.default_rent,
      input.note,
      JSON.stringify(input.equipment),
    ],
  );
  return { id, anchorId, unitId };
}

const REGISTER_SAVEPOINT = 'register_property';

/**
 * 建立物件（P0-06 AC5，ADR-0028 決議 1、2、6）。錨點、0000 單位、物件在同一個交易，任一失敗一起回滾。
 *
 * 有鍵時最後登錄建號，結果只有兩種（見 RegisterPropertyResult）：
 * - 鍵撞到自己組織：用 savepoint 把這次建立的列與稽核事件全部退掉，回自己既有的物件。這是唯一的例外。
 * - 其他情況：物件留著，回傳相同的結果。鍵撞到別的組織時，審核台項目與平台鏈的事件由資料庫函式寫入。
 * 格式錯誤等例外原樣丟出，呼叫端必須讓交易回滾。
 *
 * 登錄事件寫在登錄建號之前：函式撞號時會寫平台鏈，鎖的順序要固定是組織鏈、平台鏈。
 * 撞到自己組織時，savepoint 連同這筆事件一起退掉。
 */
export async function registerProperty(tx: OrgTx, input: PropertyInput): Promise<RegisterPropertyResult> {
  const key = input.anchor?.key;
  if (!key) {
    const { id, unitId } = await insertPropertyRows(tx, input);
    await auditPropertyCreate(tx, id, unitId);
    return { kind: 'created', id };
  }

  await tx.query(`SAVEPOINT ${REGISTER_SAVEPOINT}`);
  const { id, anchorId, unitId } = await insertPropertyRows(tx, input);
  await auditPropertyCreate(tx, id, unitId);
  // 登錄建號要在物件列之後：函式確認呼叫者組織有物件指向這個錨點
  let claim;
  try {
    claim = await claimAnchorKey(tx, anchorId, key);
  } catch (error) {
    rethrowAnchorError(error);
  }
  if (claim.kind === 'existing') {
    await tx.query(`ROLLBACK TO SAVEPOINT ${REGISTER_SAVEPOINT}`);
    await tx.query(`RELEASE SAVEPOINT ${REGISTER_SAVEPOINT}`);
    return { kind: 'existing', id: claim.propertyId };
  }
  await tx.query(`RELEASE SAVEPOINT ${REGISTER_SAVEPOINT}`);
  return { kind: 'created', id };
}

/** 稽核與業務資料同一個交易。payload 不放名稱與地址：canonical 寫入後刪不掉（ADR-0019 決議 5）。 */
async function auditPropertyCreate(tx: OrgTx, id: string, unitId: string): Promise<void> {
  await appendAudit(tx, { action: 'property.create', object: { type: 'property', id }, payload: { rental_unit_id: unitId } });
}

/**
 * 建立物件，回傳物件 ID。簡化版：撞到自己組織時回自己既有的物件 ID，其他情況回新物件 ID。
 * 要分辨結果的呼叫端（route）用 registerProperty。
 */
export async function createProperty(tx: OrgTx, input: PropertyInput): Promise<string> {
  return (await registerProperty(tx, input)).id;
}

export type SetAnchorKeyResult =
  /** 找不到物件（含別的組織的）。 */
  | { kind: 'not_found' }
  /** 登錄成立。anchor 是使用者填的鍵。鍵有沒有撞到別的組織，這裡看不出來（ADR-0028 決議 1）。 */
  | { kind: 'accepted'; anchor: PropertyAnchor }
  /** 鍵已被自己組織登錄。propertyId 是自己既有的物件，這個物件維持原樣。 */
  | { kind: 'existing'; propertyId: string };

const SET_KEY_SAVEPOINT = 'set_anchor_key';

/**
 * 補建號與修正建號：物件填上鍵。找不到物件（含別的組織的）回 not_found。
 * 結果見 SetAnchorKeyResult。物件已合併或停用丟 AnchorKeyLockedError，格式錯誤丟 AnchorKeyRejectedError，
 * 這兩種呼叫端必須讓交易回滾，因為 PostgreSQL 在函式丟錯後交易已中止。
 * 登錄事件寫在登錄建號之前，原因同 registerProperty。撞到自己組織時，savepoint 連同事件一起退掉。
 */
export async function setPropertyAnchorKey(tx: OrgTx, propertyId: string, key: AnchorKey): Promise<SetAnchorKeyResult> {
  const { rows } = await tx.query<{ rental_unit_id: string }>(
    'SELECT rental_unit_id FROM org.properties WHERE id = $1 FOR UPDATE',
    [propertyId],
  );
  if (!rows[0]) return { kind: 'not_found' };
  const unitId = rows[0].rental_unit_id;
  const current = await fetchUnitAnchor(tx, unitId);
  if (!current) return { kind: 'not_found' };

  await tx.query(`SAVEPOINT ${SET_KEY_SAVEPOINT}`);
  await appendAudit(tx, {
    action: 'property.anchor_key',
    object: { type: 'property', id: propertyId },
    payload: { rental_unit_id: unitId },
  });
  let claim;
  try {
    claim = await claimAnchorKey(tx, current.anchorId, key);
  } catch (error) {
    rethrowAnchorError(error);
  }
  if (claim.kind === 'existing') {
    await tx.query(`ROLLBACK TO SAVEPOINT ${SET_KEY_SAVEPOINT}`);
    await tx.query(`RELEASE SAVEPOINT ${SET_KEY_SAVEPOINT}`);
    return { kind: 'existing', propertyId: claim.propertyId };
  }
  await tx.query(`RELEASE SAVEPOINT ${SET_KEY_SAVEPOINT}`);
  const anchor = (await fetchUnitAnchor(tx, unitId))?.anchor;
  if (!anchor) return { kind: 'not_found' };
  return { kind: 'accepted', anchor };
}

/** 修改物件。找不到（含別的組織的物件）回 null。不改租賃單位。 */
export async function updateProperty(tx: OrgTx, id: string, input: PropertyInput): Promise<Property | null> {
  // 鎖住這一列再讀：兩個修改重疊時，後到的看到的是前一個提交後的值，稽核的 changed 才不會漏
  const { rows: current } = await tx.query<Row>(`SELECT ${COLUMNS} FROM org.properties WHERE id = $1 FOR UPDATE`, [id]);
  if (!current[0]) return null;
  const before = toProperty(current[0], null, null);
  await ensureNames(tx, input.equipment.map((i) => i.name));
  const { rows } = await tx.query<Row>(
    `UPDATE org.properties
        SET name = $2, address = $3, type = COALESCE($4, type), size = $5, default_rent = $6,
            note = $7, equipment = $8::jsonb, updated_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, input.name, input.address, input.type ?? null, input.size, input.default_rent, input.note, JSON.stringify(input.equipment)],
  );
  if (!rows[0]) return null;
  const afterUnitId = rows[0].rental_unit_id;
  const after = toProperty(
    rows[0],
    (await fetchUnitAnchor(tx, afterUnitId))?.anchor ?? null,
    (await fetchUnits(tx, [afterUnitId])).get(afterUnitId) ?? null,
  );
  // 沒有任何欄位改變時不寫事件：只會增加鏈頭的鎖競爭與雜訊
  const changed = changedFields(before, after);
  if (changed.length > 0) {
    await appendAudit(tx, { action: 'property.update', object: { type: 'property', id }, payload: { changed } });
  }
  return after;
}

const AUDITED_FIELDS = ['name', 'address', 'type', 'size', 'default_rent', 'note', 'equipment'] as const;

/** 被改動的欄位名稱，不含值。 */
function changedFields(before: Property, after: Property): string[] {
  return AUDITED_FIELDS.filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
}

export type RemovePropertyResult = 'deleted' | 'archived' | 'not_found';

/**
 * 刪除物件（P0-06 AC8，ADR-0025 決議 14）。
 * - 物件有任何案件：改為封存，回 'archived'。重複封存不再寫稽核。
 * - 沒有案件：刪除物件列，回 'deleted'。租賃單位與錨點留在 registry，沒有任何組織的物件指向的單位
 *   由觸發器轉 retired（0032）。
 * - 找不到（含別的組織的物件）：回 'not_found'。
 * 「有沒有案件」問 contract-links.ts 的接縫，它在同一個交易內查 org.cases 與 org.contracts。
 */
export async function removeProperty(tx: OrgTx, id: string): Promise<RemovePropertyResult> {
  const { rows } = await tx.query<{ rental_unit_id: string; archived_at: Date | null }>(
    'SELECT rental_unit_id, archived_at FROM org.properties WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) return 'not_found';
  const { rental_unit_id: unitId, archived_at: archivedAt } = rows[0];

  if (await hasCasesForProperty(id, tx)) {
    if (!archivedAt) {
      await tx.query('UPDATE org.properties SET archived_at = now(), updated_at = now() WHERE id = $1', [id]);
      await appendAudit(tx, { action: 'property.archive', object: { type: 'property', id }, payload: { rental_unit_id: unitId } });
    }
    return 'archived';
  }

  await tx.query('DELETE FROM org.properties WHERE id = $1', [id]);
  await appendAudit(tx, { action: 'property.delete', object: { type: 'property', id }, payload: { rental_unit_id: unitId } });
  return 'deleted';
}

export type CreateSubletResult =
  | { kind: 'created'; id: string; unitId: string; suffix: string }
  | { kind: 'not_found' }
  | { kind: 'archived' }
  /** 整戶有已完成且租期未屆滿的租賃合約，使用者還沒確認（P0-06 AC4）。 */
  | { kind: 'needs_confirmation' };

// registry 函式丟出的 SQLSTATE（見 0032 的 create_sublet_unit）
const PG_NO_DATA_FOUND = 'P0002'; // 來源單位不存在，或不是呼叫者組織的
const PG_OBJECT_NOT_IN_STATE = '55000'; // 錨點已合併或停用
const PG_INVALID_PARAMETER = '22023'; // 房號或樓層格式
const PG_PROGRAM_LIMIT = '54000'; // 單位後綴用完

/** registry 拒絕新增分租單位（房號格式、錨點已合併、後綴用完）。呼叫端必須讓交易回滾。 */
export class SubletUnitRejectedError extends Error {}

/**
 * 在來源物件的錨點下新增分租單位與新物件，同一個交易（ADR-0025 決議 13）。
 * 單位後綴由 registry 函式在鎖住錨點後取下一號，從 0001 起。房號只存標籤。
 * 來源物件不是呼叫者組織的，等同找不到，所以不可能掛到別的組織的錨點。
 * 整戶有生效中的租賃合約而且 input.confirmed 不是 true 時，不建立，回 needs_confirmation。
 */
export async function createSubletUnit(tx: OrgTx, sourcePropertyId: string, input: SubletInput): Promise<CreateSubletResult> {
  const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM org.properties WHERE id = $1 FOR UPDATE`, [sourcePropertyId]);
  const source = rows[0];
  if (!source) return { kind: 'not_found' };
  if (source.archived_at) return { kind: 'archived' };

  if (!input.confirmed) {
    const wholePropertyId = await findWholePropertyId(tx, source.rental_unit_id);
    if (wholePropertyId && (await hasActiveLeaseForProperty(wholePropertyId, tx))) return { kind: 'needs_confirmation' };
  }

  const unitId = newUlid();
  let suffix: string;
  try {
    const { rows: created } = await tx.query<{ suffix: string }>('SELECT * FROM registry.create_sublet_unit($1, $2, $3, $4)', [
      source.rental_unit_id,
      unitId,
      input.label,
      input.floor,
    ]);
    suffix = created[0].suffix;
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    if (code === PG_NO_DATA_FOUND) return { kind: 'not_found' };
    if (code === PG_OBJECT_NOT_IN_STATE || code === PG_INVALID_PARAMETER || code === PG_PROGRAM_LIMIT) {
      throw new SubletUnitRejectedError(message);
    }
    throw error;
  }

  const id = newUlid();
  await tx.query(
    `INSERT INTO org.properties (id, org_id, rental_unit_id, name, address, type, size, default_rent, note, equipment)
     VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, NULL, NULL, '', '[]'::jsonb)`,
    [id, unitId, input.name ?? `${source.name} ${input.label}`, source.address, input.type ?? '套房'],
  );
  await appendAudit(tx, {
    action: 'property.sublet_create',
    object: { type: 'property', id },
    payload: { rental_unit_id: unitId, suffix },
  });
  return { kind: 'created', id, unitId, suffix };
}

/** 同一錨點下，呼叫者組織的整戶（後綴 0000）物件 ID。沒有（例如已刪除）回 null。 */
async function findWholePropertyId(tx: OrgTx, unitId: string): Promise<string | null> {
  const { rows } = await tx.query<{ property_id: string; suffix: string }>(
    'SELECT property_id, suffix FROM registry.get_sibling_units($1)',
    [unitId],
  );
  return rows.find((r) => r.suffix === '0000')?.property_id ?? null;
}

/** 與這個營運資料同屬一個物件的、呼叫者組織自己的營運資料與租賃單位，依後綴排序。找不到回 null。 */
export async function listSiblingUnits(tx: OrgTx, propertyId: string): Promise<SiblingUnit[] | null> {
  const { rows: own } = await tx.query<{ rental_unit_id: string }>('SELECT rental_unit_id FROM org.properties WHERE id = $1', [propertyId]);
  if (!own[0]) return null;
  const { rows } = await tx.query<{ property_id: string; unit_id: string }>(
    'SELECT property_id, unit_id FROM registry.get_sibling_units($1)',
    [own[0].rental_unit_id],
  );
  const units = await fetchUnits(
    tx,
    rows.map((r) => r.unit_id),
  );
  const { rows: props } = await tx.query<{ id: string; name: string; archived_at: Date | null }>(
    'SELECT id, name, archived_at FROM org.properties WHERE id = ANY($1::text[])',
    [rows.map((r) => r.property_id)],
  );
  const propById = new Map(props.map((p) => [p.id, p]));
  return rows.flatMap((r) => {
    const unit = units.get(r.unit_id);
    const prop = propById.get(r.property_id);
    if (!unit || !prop) return [];
    return [{ ...unit, property_id: r.property_id, name: prop.name, archived_at: isoOrNull(prop.archived_at) }];
  });
}
