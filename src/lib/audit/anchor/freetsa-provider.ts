import { randomBytes } from 'node:crypto';
import { FREETSA_ROOT_CA_PEM } from './freetsa-root';
import { assertRoot, type IssuedReceipt, type AnchorProvider, type AnchorVerdict } from './provider';
import { buildTimestampRequest, parseTimestampResponse, verifyTimestampToken } from './rfc3161';

// RFC 3161 的 adapter（ADR-0019 決議 9）。預設指向 FreeTSA，pilot 前換 TWCA 或中華電信時，
// 只換 url、id 與信任根，請求與回執格式相同。
//
// 限制（FreeTSA）：每個 IP 每秒 1 次，沒有 SLA，營運者資訊不透明。不重試：429 與逾時都直接丟錯，
// 由下一次排程再送（ADR-0019 決議 10）。這個 adapter 只用在 demo，不是正式主錨。

export const FREETSA_URL = 'https://freetsa.org/tsr';
/** 回應上限。FreeTSA 的回執約 4.6 KB（含兩張憑證），64 KB 已有餘裕，超過就不是正常的 TSA。 */
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface Rfc3161ProviderOptions {
  /** 預設 'freetsa'。換服務商時改名，回執才找得回對應的 adapter。 */
  id?: string;
  url?: string;
  /** 信任根（PEM）。預設是 FreeTSA 的根。 */
  trustedRootsPem?: readonly string[];
  /** 測試注入。預設全域 fetch。 */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** 測試注入 nonce。預設 8 位元組隨機。 */
  nonce?: () => Uint8Array;
}

export function createFreeTsaProvider(options: Rfc3161ProviderOptions = {}): AnchorProvider {
  const url = options.url ?? FREETSA_URL;
  const roots = options.trustedRootsPem ?? [FREETSA_ROOT_CA_PEM];
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const makeNonce = options.nonce ?? (() => randomBytes(8));

  return {
    id: options.id ?? 'freetsa',

    async anchor(rootHex): Promise<IssuedReceipt> {
      assertRoot(rootHex);
      const nonce = makeNonce();
      const body = buildTimestampRequest(rootHex, nonce);
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/timestamp-query' },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`時戳服務回應 HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_RESPONSE_BYTES) throw new Error(`時戳回應過大：${bytes.length} 位元組`);
      const parsed = parseTimestampResponse(bytes);
      if (!parsed.token) {
        throw new Error(`時戳服務拒絕請求：status ${parsed.status}${parsed.failInfo ? `，failInfo ${parsed.failInfo}` : ''}`);
      }
      // 收到就驗：簽章、信任鏈、雜湊與 nonce 任何一項不符都不保存
      const verdict = verifyTimestampToken(parsed.token, { rootHex, trustedRootsPem: roots, expectedNonce: nonce });
      if (!verdict.ok) throw new Error(`時戳回執驗證失敗：${verdict.reason}`);
      return { receipt: parsed.token.toString('base64'), issuedAt: verdict.issuedAt };
    },

    async verify(rootHex, receipt): Promise<AnchorVerdict> {
      const token = Buffer.from(receipt, 'base64');
      if (token.length === 0) return { ok: false, reason: '回執是空的' };
      const verdict = verifyTimestampToken(token, { rootHex, trustedRootsPem: roots });
      return verdict.ok ? { ok: true, issuedAt: verdict.issuedAt } : verdict;
    },
  };
}
