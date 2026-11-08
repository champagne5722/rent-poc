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
  return id;
}

/** 修改物件。找不到（含別的組織的物件）回 null。不改租賃單位。 */
export async function updateProperty(tx: OrgTx, id: string, input: PropertyInput): Promise<Property | null> {
  await ensureNames(tx, input.equipment.map((i) => i.name));
  const { rows } = await tx.query<Row>(
    `UPDATE org.properties
        SET name = $2, address = $3, type = COALESCE($4, type), size = $5, default_rent = $6,
            note = $7, equipment = $8::jsonb, updated_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, input.name, input.address, input.type ?? null, input.size, input.default_rent, input.note, JSON.stringify(input.equipment)],
  );
  return rows[0] ? toProperty(rows[0]) : null;
}

/**
 * 刪除物件，回傳有沒有刪到。租賃單位與錨點留在 registry（ADR-0025 決議 14）。
 * 「有合約只能封存」的檢查等合約進 PostgreSQL 後（MIL-83）再加。
 */
export async function deleteProperty(tx: OrgTx, id: string): Promise<boolean> {
  const { rows } = await tx.query('DELETE FROM org.properties WHERE id = $1 RETURNING id', [id]);
  return rows.length > 0;
}
