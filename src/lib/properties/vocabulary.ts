import type { OrgTx } from '@/lib/pg/with-tx';
import { newUlid } from '@/lib/pg/ulid';
import { EQUIPMENT_OPTIONS } from '@/lib/types';
import type { EquipmentVocabularyItem } from '@/lib/types';

// 設備詞彙庫的 repository（ADR-0008，GLOSSARY：組織層級的設備項目字典）。
// 所有方法在 withTx 給的 tx 內執行，組織由交易的 app.org_id 決定，RLS 負責隔離。
// 平台預設在前、自訂項目在後，各自依新增順序。ULID 在同一程序內單調遞增，所以 ORDER BY id 就是新增順序。

interface Row {
  id: string;
  name: string;
  is_custom: boolean;
  created_at: Date;
}

const COLUMNS = 'id, name, is_custom, created_at';

function toItem(row: Row): EquipmentVocabularyItem {
  return { id: row.id, name: row.name, is_custom: row.is_custom, created_at: row.created_at.toISOString() };
}

/**
 * 補齊目前組織的平台預設項目。已經齊全時只花一次查詢。
 * 每次寫入詞彙庫之前都要先呼叫：先有自訂的「冷氣」再補預設，那筆預設會被當成撞名略過，永遠變成自訂。
 */
async function ensureDefaults(tx: OrgTx): Promise<void> {
  const { rows } = await tx.query<{ n: string }>('SELECT count(*) AS n FROM org.equipment_vocabulary WHERE NOT is_custom');
  if (Number(rows[0].n) >= EQUIPMENT_OPTIONS.length) return;
  await insertMissing(tx, [...EQUIPMENT_OPTIONS], false);
}

/** 一次補上缺的名稱，已存在的略過。ID 依傳入順序遞增，所以清單順序就是新增順序。 */
async function insertMissing(tx: OrgTx, names: string[], isCustom: boolean): Promise<void> {
  await tx.query(
    `INSERT INTO org.equipment_vocabulary (id, org_id, name, is_custom)
     SELECT u.id, current_setting('app.org_id', true), u.name, $3::boolean
       FROM unnest($1::text[], $2::text[]) AS u(id, name)
     ON CONFLICT (org_id, name) DO NOTHING`,
    [names.map(() => newUlid()), names, isCustom],
  );
}

// 注意：這是「讀」，但組織第一次使用時會寫入預設項目，所以呼叫端的交易必須允許寫入。
export async function listVocabulary(tx: OrgTx): Promise<EquipmentVocabularyItem[]> {
  await ensureDefaults(tx);
  const { rows } = await tx.query<Row>(
    `SELECT ${COLUMNS} FROM org.equipment_vocabulary ORDER BY is_custom ASC, id ASC`,
  );
  return rows.map(toItem);
}

/** 新增一個自訂項目，回傳新項目。名稱空白，或與既有項目（含平台預設）同名時回 null。 */
export async function addCustomItem(tx: OrgTx, name: string): Promise<EquipmentVocabularyItem | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  await ensureDefaults(tx);
  const { rows } = await tx.query<Row>(
    `INSERT INTO org.equipment_vocabulary (id, org_id, name, is_custom)
     VALUES ($1, current_setting('app.org_id', true), $2, true)
     ON CONFLICT (org_id, name) DO NOTHING
     RETURNING ${COLUMNS}`,
    [newUlid(), trimmed],
  );
  return rows[0] ? toItem(rows[0]) : null;
}

/** 存物件時呼叫：清單裡詞彙庫還沒有的名稱補成自訂項目，讓同組織的其他物件也選得到。 */
export async function ensureNames(tx: OrgTx, names: string[]): Promise<void> {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (unique.length === 0) return;
  await ensureDefaults(tx);
  await insertMissing(tx, unique, true);
}
