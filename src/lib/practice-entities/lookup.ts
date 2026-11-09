import { statutoryTitle, type BusinessType, type LicenseKind } from '../labels';
import type { OrgTx } from '../pg/with-tx';
import type { CredentialState } from '../registry-rules';

// 執業主體批次查詢（MIL-109，F 線資產總覽的需求 MIL-94）。
// 以執業主體 ID 清單一次查詢，回傳名稱、法定稱謂與各業別的驗證狀態。任何組織脈絡都能呼叫。
// 只回這些欄位，不回統編、組織 ID、人員（ADR-0012 決議 8）。查無的 ID 不出現在結果裡。

export const LOOKUP_MAX_IDS = 500;

export interface PracticeEntitySummary {
  id: string;
  name: string;
  /** 各業別的法定稱謂與驗證狀態。尚未登錄任何業別時是空陣列。 */
  licenses: Array<{ kind: LicenseKind; title: string; state: CredentialState }>;
  /**
   * 這個執業主體在畫面上的法定稱謂。
   * 只有一種業別時是該業別的稱謂。兼營時要給 businessType 才能決定，沒給或決定不了時是 null，畫面改列 licenses。
   */
  title: string | null;
  /** 至少有一個業別是已驗證。畫面據此顯示「證書資料已核對」類的標章。 */
  hasVerifiedLicense: boolean;
}

export async function lookupPracticeEntities(
  tx: OrgTx,
  ids: readonly string[],
  options: { businessType?: BusinessType } = {},
): Promise<PracticeEntitySummary[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  if (unique.length > LOOKUP_MAX_IDS) throw new RangeError(`一次最多查 ${LOOKUP_MAX_IDS} 個執業主體`);

  const { rows } = await tx.query<{ entity_id: string; name: string; kind: LicenseKind | null; state: CredentialState | null }>(
    'SELECT * FROM registry.lookup_practice_entities($1::text[])',
    [unique],
  );
  const byEntity = new Map<string, PracticeEntitySummary>();
  for (const row of rows) {
    let entry = byEntity.get(row.entity_id);
    if (!entry) {
      entry = { id: row.entity_id, name: row.name, licenses: [], title: null, hasVerifiedLicense: false };
      byEntity.set(row.entity_id, entry);
    }
    if (row.kind && row.state) {
      entry.licenses.push({ kind: row.kind, title: statutoryTitle(row.kind), state: row.state });
      if (row.state === 'verified') entry.hasVerifiedLicense = true;
    }
  }
  for (const entry of byEntity.values()) {
    const kinds = entry.licenses.map((l) => l.kind);
    if (kinds.length === 0) continue;
    try {
      entry.title = statutoryTitle(kinds, options.businessType);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  // 依傳入順序回傳，方便呼叫端對照
  return unique.flatMap((id) => byEntity.get(id) ?? []);
}
