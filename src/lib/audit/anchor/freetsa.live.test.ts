import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFreeTsaProvider } from './freetsa-provider';

// 實際呼叫 FreeTSA 一次（MIL-88 驗收條件）。預設跳過：FreeTSA 每個 IP 每秒限 1 次、沒有 SLA，不放進一般的測試執行。
//
// 重跑：
//   FREETSA_LIVE=1 npx vitest run src/lib/audit/anchor/freetsa.live.test.ts
// 要把這次的回執存成離線測試的樣本（fixtures/freetsa-sample.json），再加 FREETSA_SAVE_SAMPLE=1。
//
// 送出去的只有 SHA-256 雜湊，來源是一行固定文字加日期，不含任何業務資料。

const live = process.env.FREETSA_LIVE === '1';
const SAMPLE = new URL('./fixtures/freetsa-sample.json', import.meta.url);

describe.skipIf(!live)('FreeTSA（實際連線）', () => {
  it('送出一個雜湊，取得回執，用 FreeTSA 的根驗證簽章與信任鏈', async () => {
    const provider = createFreeTsaProvider();
    const root = createHash('sha256').update(`rent-poc MIL-88 FreeTSA live check ${new Date().toISOString()}`).digest('hex');

    const issue = await provider.anchor(root);
    // anchor 內部已驗證過一次。這裡再用獨立的 verify 路徑驗一次（不帶 nonce）
    const verdict = await provider.verify(root, issue.receipt);
    expect(verdict).toEqual({ ok: true, issuedAt: issue.issuedAt });
    expect(Math.abs(issue.issuedAt.getTime() - Date.now())).toBeLessThan(5 * 60_000);
    // 雜湊不同必須被拒絕
    expect((await provider.verify('0'.repeat(64), issue.receipt)).ok).toBe(false);

    console.info(`[freetsa-live] root=${root} issuedAt=${issue.issuedAt.toISOString()} receiptBytes=${Buffer.from(issue.receipt, 'base64').length}`);
    if (process.env.FREETSA_SAVE_SAMPLE === '1') {
      fs.writeFileSync(SAMPLE, `${JSON.stringify({ root, receipt: issue.receipt, issuedAt: issue.issuedAt.toISOString() }, null, 2)}\n`);
    }
  }, 30_000);
});
