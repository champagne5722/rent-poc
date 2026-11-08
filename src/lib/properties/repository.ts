import { appendAudit } from '@/lib/audit';
import { propertyHasContracts } from '@/lib/contracts';
import { parseStoredEquipment } from '@/lib/equipment';
import { newUlid } from '@/lib/pg/ulid';
import type { OrgTx } from '@/lib/pg/with-tx';
import { normalizeAddress } from '@/lib/registry/address-match';
import type { Property, PropertyType } from '@/lib/types';
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

function toProperty(row: Row): Property {
  return {
    id: row.id,
    rental_unit_id: row.rental_unit_id,
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
  return rows.map(toProperty);
}

export async function getProperty(tx: OrgTx, id: string): Promise<Property | null> {
  const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM org.properties WHERE id = $1`, [id]);
  return rows[0] ? toProperty(rows[0]) : null;
}

/** 建立物件，回傳物件 ID。錨點、0000 單位、物件在同一個交易，任一失敗一起回滾。 */
export async function createProperty(tx: OrgTx, input: PropertyInput): Promise<string> {
  await ensureNames(tx, input.equipment.map((i) => i.name));

  const anchorId = newUlid();
  const unitId = newUlid();
  await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3, $4)', [
    anchorId,
    unitId,
    input.address,
    normalizeAddress(input.address).normalized,
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
  // 稽核與業務資料同一個交易。payload 不放名稱與地址：canonical 寫入後刪不掉（ADR-0019 決議 5）
  await appendAudit(tx, { action: 'property.create', object: { type: 'property', id }, payload: { rental_unit_id: unitId } });
  return id;
}

/** 修改物件。找不到（含別的組織的物件）回 null。不改租賃單位。 */
export async function updateProperty(tx: OrgTx, id: string, input: PropertyInput): Promise<Property | null> {
  // 鎖住這一列再讀：兩個修改重疊時，後到的看到的是前一個提交後的值，稽核的 changed 才不會漏
  const { rows: current } = await tx.query<Row>(`SELECT ${COLUMNS} FROM org.properties WHERE id = $1 FOR UPDATE`, [id]);
  if (!current[0]) return null;
  const before = toProperty(current[0]);
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
  const after = toProperty(rows[0]);
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

export type DeletePropertyResult = 'deleted' | 'not_found' | 'has_contracts';

/**
 * 刪除物件。租賃單位與錨點留在 registry（ADR-0025 決議 14）。
 * 物件有任何合約時只得封存，不得刪（MIL-83）：這裡先鎖住物件再檢查，回 'has_contracts'。
 * 鎖住物件列也讓同時建立合約的交易排在後面（合約的外鍵檢查要這一列的共享鎖），
 * 它醒來時物件已經不在，複合外鍵讓它失敗。資料庫的複合外鍵是最後一道防線。
 */
export async function deleteProperty(tx: OrgTx, id: string): Promise<DeletePropertyResult> {
  const { rows: locked } = await tx.query<{ rental_unit_id: string }>(
    'SELECT rental_unit_id FROM org.properties WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (locked.length === 0) return 'not_found';
  if (await propertyHasContracts(tx, id)) return 'has_contracts';

  await tx.query('DELETE FROM org.properties WHERE id = $1', [id]);
  await appendAudit(tx, { action: 'property.delete', object: { type: 'property', id }, payload: { rental_unit_id: locked[0].rental_unit_id } });
  return 'deleted';
}
