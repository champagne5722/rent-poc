import type { WithTx } from './with-tx';

// 測試用的案件種子（MIL-123）。鏡像帳的 case_id 掛了 org.cases 的複合外鍵，
// 寫分錄的測試必須先有案件。案件 ID 必須是 ULID 格式（org.cases 的 CHECK）。

/** 把好讀的標籤補成 ULID 格式的案件 ID。標籤只能用 Crockford base32 的字元（不含 I、L、O、U），最長 26 字。 */
export function testCaseId(label: string): string {
  const id = label.padStart(26, '0');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new RangeError(`測試案件標籤不能轉成 ULID：${label}`);
  return id;
}

/**
 * 在每個組織下各建一個租賃案件，用 app_rw 加該組織的脈絡寫入（FORCE RLS 下擁有者也要有脈絡）。
 * 已存在的案件略過，所以同一個測試內能重複呼叫。
 */
export async function seedCases(withTx: WithTx, orgIds: readonly string[], caseIds: readonly string[]): Promise<void> {
  for (const orgId of orgIds) {
    await withTx({ kind: 'org', orgId }, async (tx) => {
      for (const caseId of caseIds) {
        await tx.query(
          `INSERT INTO org.cases (id, org_id, kind, state, business_type, title)
           VALUES ($1, $2, 'lease', 'active', 'self_managed', '測試案件')
           ON CONFLICT DO NOTHING`,
          [caseId, orgId],
        );
      }
    });
  }
}
