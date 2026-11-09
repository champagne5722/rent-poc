import { describe, expect, it, vi } from 'vitest';
import { describeAnchorProviderContract } from './anchor-provider-contract';
import { FakeTsa, TEST_ROOT_PEM, type FakeTsaMode } from './fake-tsa-test-kit';
import { createFreeTsaProvider } from './freetsa-provider';
import { createMockAnchorProvider } from './mock-provider';

// Mock 與 FreeTSA 兩個 adapter 通過同一組契約測試（MIL-88 驗收條件）。
// FreeTSA adapter 在這裡指向離線的假 TSA。實際呼叫 FreeTSA 的測試在 freetsa.live.test.ts，預設跳過。

const NOW = new Date('2026-11-10T03:00:00.000Z');
const ROOT = '6372fd8017d79479bf568ccf1a6195bbca1db2d578b8d68b25e6ca68ebcf6ebc';

describeAnchorProviderContract('Mock', () => ({ provider: createMockAnchorProvider({ now: () => NOW }), now: NOW }));

const freeTsaWith = (tsa: FakeTsa, extra: Parameters<typeof createFreeTsaProvider>[0] = {}) =>
  createFreeTsaProvider({ fetch: tsa.fetch, trustedRootsPem: [TEST_ROOT_PEM], ...extra });

describeAnchorProviderContract('FreeTSA（離線假 TSA）', () => ({
  provider: freeTsaWith(new FakeTsa({ now: () => NOW })),
  now: NOW,
}));

describe('Mock adapter 專屬行為', () => {
  it('failNext 讓接下來 n 次 anchor 丟錯，之後恢復，calls 把失敗的也算進去', async () => {
    const mock = createMockAnchorProvider({ now: () => NOW });
    mock.failNext(2);
    await expect(mock.anchor(ROOT)).rejects.toThrow(/模擬中斷/);
    await expect(mock.anchor(ROOT)).rejects.toThrow(/模擬中斷/);
    await expect(mock.anchor(ROOT)).resolves.toMatchObject({ issuedAt: NOW });
    expect(mock.calls).toBe(3);
  });

  it('樹根格式不合時不算一次呼叫', async () => {
    const mock = createMockAnchorProvider({ now: () => NOW });
    await expect(mock.anchor('bad')).rejects.toThrow();
    expect(mock.calls).toBe(0);
  });
});

describe('FreeTSA adapter 專屬行為', () => {
  it('送出的請求只含雜湊：位元組裡找不到業務資料以外的東西，且 TSA 收到的雜湊等於樹根', async () => {
    const tsa = new FakeTsa({ now: () => NOW });
    const seen: Uint8Array[] = [];
    const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(init!.body as Uint8Array);
      return tsa.fetch(url, init);
    });
    await freeTsaWith(tsa, { fetch: spy as typeof fetch }).anchor(ROOT);
    expect(tsa.lastImprintHex).toBe(ROOT);
    expect(spy).toHaveBeenCalledTimes(1);
    // SEQUENCE { version, messageImprint(sha256, 32 bytes), nonce(8 bytes), certReq }：小於 100 位元組
    expect(seen[0].length).toBeLessThan(100);
    expect(spy.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/timestamp-query' } });
  });

  it('TSA 拒絕請求：丟錯並帶 status', async () => {
    const tsa = new FakeTsa({ now: () => NOW, mode: 'reject' });
    await expect(freeTsaWith(tsa).anchor(ROOT)).rejects.toThrow(/拒絕.*status 2/);
  });

  it.each<[FakeTsaMode, RegExp]>([
    ['wrong-imprint', /雜湊與樹根不符/],
    ['wrong-nonce', /nonce/],
    ['bad-signature', /簽章不符/],
  ])('收到的回執不合格（%s）：不保存，丟錯', async (mode, message) => {
    const tsa = new FakeTsa({ now: () => NOW, mode });
    await expect(freeTsaWith(tsa).anchor(ROOT)).rejects.toThrow(message);
  });

  it('HTTP 錯誤（例如 429 超過頻率限制）：丟錯，不重試', async () => {
    const fetchFn = vi.fn(async () => new Response('slow down', { status: 429 }));
    await expect(createFreeTsaProvider({ fetch: fetchFn as typeof fetch }).anchor(ROOT)).rejects.toThrow(/HTTP 429/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('網路中斷：原樣丟出', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(createFreeTsaProvider({ fetch: fetchFn as typeof fetch }).anchor(ROOT)).rejects.toThrow('fetch failed');
  });

  it('預設信任根是 FreeTSA 的根：假 TSA 簽的回執不被接受', async () => {
    const tsa = new FakeTsa({ now: () => NOW });
    await expect(createFreeTsaProvider({ fetch: tsa.fetch }).anchor(ROOT)).rejects.toThrow(/不在信任根之下/);
  });

  it('可以改 id，驗證時用它找回 adapter', () => {
    expect(createFreeTsaProvider({ id: 'twca' }).id).toBe('twca');
  });
});

describe('FreeTSA adapter 的回應上限', () => {
  it('回應超過 64 KB：丟錯，不解析', async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array(70 * 1024), { status: 200 }));
    await expect(createFreeTsaProvider({ fetch: fetchFn as typeof fetch }).anchor(ROOT)).rejects.toThrow(/過大/);
  });
});
