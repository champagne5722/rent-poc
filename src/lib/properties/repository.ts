import { appendAudit } from '@/lib/audit';
import { parseStoredEquipment } from '@/lib/equipment';
import { newUlid } from '@/lib/pg/ulid';
import type { OrgTx } from '@/lib/pg/with-tx';
import { normalizeAddress } from '@/lib/registry/address-match';
import { sectionLabel } from '@/lib/registry/section-code';
import type { AnchorKey } from '@/lib/registry/section-code';
import type { AnchorStatus, Property, PropertyAnchor, PropertyType } from '@/lib/types';
import type { PropertyInput } from './input';
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
  created_at: Date;
  updated_at: Date | null;
}

const COLUMNS = 'id, rental_unit_id, name, address, type, size, default_rent, note, equipment, created_at, updated_at';

/** 補建號與建立物件時填了鍵，都會遇到的錯誤。route 轉成固定的 HTTP 回應。 */
export class AnchorKeyCollisionError extends Error {
  constructor() {
    // 固定訊息，不帶鍵與對方的任何資料。B3（MIL-144）把這條路徑換成送審核台的流程
    super('撞號處理尚未實作');
  }
}
export class AnchorAlreadyKeyedError extends Error {
  constructor() {
    super('產權已建號，不能再補建號');
  }
}
/** DB 端的鍵檢查沒過（段碼表與 seed 不同步、建號格式）。純函式已先驗過，所以正常不會發生。 */
export class AnchorKeyRejectedError extends Error {}

function rethrowAnchorError(error: unknown): never {
  const { code, message } = error as { code?: string; message?: string };
  if (code === '23505') throw new AnchorKeyCollisionError();
  if (code === '55000') throw new AnchorAlreadyKeyedError();
  if (code === '22023') throw new AnchorKeyRejectedError(message);
  throw error;
}

interface AnchorRow {
  unit_id: string;
  anchor_id: string;
  status: AnchorStatus;
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

/** 讀租賃單位所屬的錨點。registry 只能經函式讀，函式只回呼叫者組織有物件指向的單位。 */
async function fetchAnchors(tx: OrgTx, unitIds: string[]): Promise<Map<string, UnitAnchor>> {
  if (unitIds.length === 0) return new Map();
  const { rows } = await tx.query<AnchorRow>('SELECT * FROM registry.get_anchors_for_units($1::text[])', [unitIds]);
  return new Map(
    rows.map((r) => [
      r.unit_id,
      {
        anchorId: r.anchor_id,
        anchor: {
          status: r.status,
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

function toProperty(row: Row, anchor: PropertyAnchor | null): Property {
  return {
    id: row.id,
    rental_unit_id: row.rental_unit_id,
    anchor,
    name: row.name,
    address: row.address,
    type: row.type,
    size: row.size,
    default_rent: row.default_rent,
    note: row.note,
    equipment: parseStoredEquipment(row.equipment),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

/** 新的在前。ULID 隨時間遞增，所以 id DESC 就是建立時間由新到舊。 */
export async function listProperties(tx: OrgTx): Promise<Property[]> {
  const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM org.properties ORDER BY id DESC`);
  const anchors = await fetchAnchors(tx, rows.map((r) => r.rental_unit_id));
  return rows.map((r) => toProperty(r, anchors.get(r.rental_unit_id)?.anchor ?? null));
}

export async function getProperty(tx: OrgTx, id: string): Promise<Property | null> {
  const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM org.properties WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  const anchors = await fetchAnchors(tx, [rows[0].rental_unit_id]);
  return toProperty(rows[0], anchors.get(rows[0].rental_unit_id)?.anchor ?? null);
}

/**
 * 建立物件，回傳物件 ID。錨點、0000 單位、物件在同一個交易，任一失敗一起回滾。
 * 有鍵時最後補建號：撞號丟 AnchorKeyCollisionError，呼叫端必須讓交易回滾，才不會留下半成品。
 */
export async function createProperty(tx: OrgTx, input: PropertyInput): Promise<string> {
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
  // 補建號要在物件列之後：函式確認呼叫者組織有物件指向這個錨點
  if (input.anchor?.key) await assignAnchorKey(tx, anchorId, input.anchor.key);
  // 稽核與業務資料同一個交易。payload 不放名稱與地址：canonical 寫入後刪不掉（ADR-0019 決議 5）
  await appendAudit(tx, { action: 'property.create', object: { type: 'property', id }, payload: { rental_unit_id: unitId } });
  return id;
}

async function assignAnchorKey(tx: OrgTx, anchorId: string, key: AnchorKey): Promise<void> {
  try {
    await tx.query('SELECT registry.assign_anchor_key($1, $2, $3, $4, $5, $6)', [
      anchorId,
      key.cityCode,
      key.townCode,
      key.sectionCode,
      key.buildingNo,
      key.subNo,
    ]);
  } catch (error) {
    rethrowAnchorError(error);
  }
}

/**
 * 補建號：待驗證的錨點補上鍵，沒有撞號時轉已建號。回傳新的產權摘要。找不到物件（含別的組織的）回 null。
 * 撞號丟 AnchorKeyCollisionError，已建號丟 AnchorAlreadyKeyedError。呼叫端必須讓交易回滾，
 * 因為 PostgreSQL 在函式丟錯後交易已中止。
 */
export async function setPropertyAnchorKey(tx: OrgTx, propertyId: string, key: AnchorKey): Promise<PropertyAnchor | null> {
  const { rows } = await tx.query<{ rental_unit_id: string }>(
    'SELECT rental_unit_id FROM org.properties WHERE id = $1 FOR UPDATE',
    [propertyId],
  );
  if (!rows[0]) return null;
  const unitId = rows[0].rental_unit_id;
  const before = (await fetchAnchors(tx, [unitId])).get(unitId);
  if (!before) return null;
  await assignAnchorKey(tx, before.anchorId, key);
  await appendAudit(tx, {
    action: 'property.anchor_key',
    object: { type: 'property', id: propertyId },
    payload: { rental_unit_id: unitId },
  });
  return (await fetchAnchors(tx, [unitId])).get(unitId)?.anchor ?? null;
}

/** 修改物件。找不到（含別的組織的物件）回 null。不改租賃單位。 */
export async function updateProperty(tx: OrgTx, id: string, input: PropertyInput): Promise<Property | null> {
  // 鎖住這一列再讀：兩個修改重疊時，後到的看到的是前一個提交後的值，稽核的 changed 才不會漏
  const { rows: current } = await tx.query<Row>(`SELECT ${COLUMNS} FROM org.properties WHERE id = $1 FOR UPDATE`, [id]);
  if (!current[0]) return null;
  const before = toProperty(current[0], null);
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
  const after = toProperty(rows[0], (await fetchAnchors(tx, [rows[0].rental_unit_id])).get(rows[0].rental_unit_id)?.anchor ?? null);
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

/**
 * 刪除物件，回傳有沒有刪到。租賃單位與錨點留在 registry（ADR-0025 決議 14）。
 * 「有合約只能封存」的檢查等合約進 PostgreSQL 後（MIL-83）再加。
 */
export async function deleteProperty(tx: OrgTx, id: string): Promise<boolean> {
  const { rows } = await tx.query<{ rental_unit_id: string }>(
    'DELETE FROM org.properties WHERE id = $1 RETURNING rental_unit_id',
    [id],
  );
  if (rows.length === 0) return false;
  await appendAudit(tx, { action: 'property.delete', object: { type: 'property', id }, payload: { rental_unit_id: rows[0].rental_unit_id } });
  return true;
}
