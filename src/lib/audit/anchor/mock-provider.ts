import { assertRoot, type IssuedReceipt, type AnchorProvider, type AnchorVerdict } from './provider';

// Mock 錨定服務，給測試與沒有網路的本機開發使用（ADR-0019 決議 9）。
// 回執只是「樹根加時間」的文字，沒有任何簽章，不具備防竄改的效力。
// 正式環境不得使用：anchorProvidersFromEnv 在 NODE_ENV=production 時拒絕 mock。

export interface MockAnchorProvider extends AnchorProvider {
  /** anchor 被呼叫的次數（含失敗的）。測試用來確認「沒有變動時不呼叫外部服務」。 */
  readonly calls: number;
  /** 接下來 n 次 anchor 丟錯，模擬外部服務中斷。 */
  failNext(n: number): void;
}

export function createMockAnchorProvider(options: { now: () => Date }): MockAnchorProvider {
  let calls = 0;
  let failures = 0;
  return {
    id: 'mock',
    get calls() {
      return calls;
    },
    failNext(n) {
      failures = n;
    },
    async anchor(rootHex): Promise<IssuedReceipt> {
      assertRoot(rootHex);
      calls++;
      if (failures > 0) {
        failures--;
        throw new Error('Mock 錨定服務：模擬中斷');
      }
      const issuedAt = options.now();
      const receipt = Buffer.from(JSON.stringify({ mock: 1, root: rootHex, at: issuedAt.toISOString() })).toString('base64');
      return { receipt, issuedAt };
    },
    async verify(rootHex, receipt): Promise<AnchorVerdict> {
      try {
        const parsed = JSON.parse(Buffer.from(receipt, 'base64').toString('utf8')) as { mock?: number; root?: string; at?: string };
        if (parsed.mock !== 1 || typeof parsed.root !== 'string' || typeof parsed.at !== 'string') return { ok: false, reason: '回執格式不合' };
        if (parsed.root !== rootHex) return { ok: false, reason: '回執的雜湊與樹根不符' };
        const issuedAt = new Date(parsed.at);
        if (Number.isNaN(issuedAt.getTime())) return { ok: false, reason: '回執的時間格式不合' };
        return { ok: true, issuedAt };
      } catch {
        return { ok: false, reason: '回執無法解析' };
      }
    },
  };
}
