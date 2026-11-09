import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDer } from './der';
import { FakeTsa, TEST_ROOT_PEM } from './fake-tsa-test-kit';
import { FREETSA_ROOT_CA_PEM } from './freetsa-root';
import { buildTimestampRequest, parseTimestampResponse, verifyTimestampToken } from './rfc3161';

// RFC 3161 的請求、回執解析與驗證（MIL-88）。
// 請求的期望位元組由 `openssl ts -query -digest … -sha256 -no_nonce -cert` 產生，不經過被測程式。

const ROOT = '6372fd8017d79479bf568ccf1a6195bbca1db2d578b8d68b25e6ca68ebcf6ebc';
const OPENSSL_QUERY =
  '30390201013031300d0609608648016503040201050004206372fd8017d79479bf568ccf1a6195bbca1db2d578b8d68b25e6ca68ebcf6ebc0101ff';
const NOW = new Date('2026-11-10T03:00:00.000Z');
const NONCE = Buffer.from('0123456789abcdef', 'hex');

describe('buildTimestampRequest', () => {
  it('沒有 nonce 時，位元組與 openssl 產生的相同', () => {
    expect(buildTimestampRequest(ROOT).toString('hex')).toBe(OPENSSL_QUERY);
  });

  it('帶 nonce 時，nonce 在雜湊之後、certReq 之前', () => {
    const req = parseDer(buildTimestampRequest(ROOT, NONCE));
    expect(req.children.map((c) => c.tag)).toEqual([0x02, 0x30, 0x02, 0x01]);
    expect(req.children[2].value.toString('hex')).toBe('0123456789abcdef');
  });

  it('雜湊格式不合丟錯', () => {
    expect(() => buildTimestampRequest('abc')).toThrow(/64 位/);
  });
});

function issue(options: { mode?: ConstructorParameters<typeof FakeTsa>[0]['mode'] } = {}) {
  const tsa = new FakeTsa({ now: () => NOW, ...options });
  const response = tsa.respond(buildTimestampRequest(ROOT, NONCE));
  return { tsa, response };
}

describe('parseTimestampResponse', () => {
  it('核發時取出 TimeStampToken', () => {
    const parsed = parseTimestampResponse(issue().response);
    expect(parsed.status).toBe(0);
    expect(parsed.token).not.toBeNull();
  });

  it('拒絕時沒有 token', () => {
    const parsed = parseTimestampResponse(issue({ mode: 'reject' }).response);
    expect(parsed).toMatchObject({ status: 2, token: null });
  });

  it('格式損毀丟錯', () => {
    expect(() => parseTimestampResponse(Buffer.from('3000', 'hex'))).toThrow();
    expect(() => parseTimestampResponse(Buffer.from('hello'))).toThrow();
  });
});

describe('verifyTimestampToken', () => {
  const token = () => parseTimestampResponse(issue().response).token!;
  const options = { rootHex: ROOT, trustedRootsPem: [TEST_ROOT_PEM] };

  it('正確的回執通過，並回傳 TSA 記錄的時間與 nonce', () => {
    const verdict = verifyTimestampToken(token(), { ...options, expectedNonce: NONCE });
    expect(verdict).toMatchObject({ ok: true, nonce: BigInt('0x0123456789abcdef') });
    expect(verdict.ok && verdict.issuedAt.toISOString()).toBe(NOW.toISOString());
  });

  it('驗證已保存的回執時不需要 nonce', () => {
    expect(verifyTimestampToken(token(), options).ok).toBe(true);
  });

  it('雜湊與樹根不同：拒絕', () => {
    const other = 'f'.repeat(64);
    expect(verifyTimestampToken(token(), { ...options, rootHex: other })).toEqual({ ok: false, reason: '回執的雜湊與樹根不符' });
  });

  it('nonce 不同：拒絕', () => {
    expect(verifyTimestampToken(token(), { ...options, expectedNonce: Buffer.from('01', 'hex') })).toMatchObject({ ok: false, reason: expect.stringContaining('nonce') });
  });

  it('沒有信任根：拒絕，不退回只驗內嵌憑證', () => {
    expect(verifyTimestampToken(token(), { ...options, trustedRootsPem: [] })).toMatchObject({ ok: false, reason: expect.stringContaining('信任根') });
  });

  it('內嵌憑證不在信任根之下：拒絕', () => {
    // 用 FreeTSA 的根當信任根：它是有效的憑證，但不是測試 TSA 憑證的簽發者
    expect(verifyTimestampToken(token(), { ...options, trustedRootsPem: [FREETSA_ROOT_CA_PEM] })).toEqual({
      ok: false,
      reason: '簽署憑證不在信任根之下',
    });
  });

  it('簽章被改過：拒絕', () => {
    const verdict = verifyTimestampToken(parseTimestampResponse(issue({ mode: 'bad-signature' }).response).token!, options);
    expect(verdict).toEqual({ ok: false, reason: '簽章不符' });
  });

  it('回執內的雜湊被換掉但簽章不變：拒絕', () => {
    const verdict = verifyTimestampToken(parseTimestampResponse(issue({ mode: 'wrong-imprint' }).response).token!, options);
    expect(verdict.ok).toBe(false);
  });

  it('位元組被改動的回執：拒絕而不是丟錯', () => {
    const t = Buffer.from(token());
    t[t.length - 5] ^= 0x01;
    expect(verifyTimestampToken(t, options).ok).toBe(false);
    expect(verifyTimestampToken(Buffer.from('garbage'), options)).toMatchObject({ ok: false });
  });

  it('憑證在回執時間已過期或尚未生效：拒絕', () => {
    const early = new FakeTsa({ now: () => new Date('2020-01-01T00:00:00Z') });
    const t = parseTimestampResponse(early.respond(buildTimestampRequest(ROOT))).token!;
    expect(verifyTimestampToken(t, options)).toEqual({ ok: false, reason: '簽署憑證在回執時間已過期或尚未生效' });
  });
});

// 2026-11-09 實際呼叫 FreeTSA 錄下的回執（freetsa.live.test.ts 產生）。openssl 的獨立驗證結果：
//   openssl ts -verify -in token.der -token_in -digest <root> -sha256 -CAfile cacert.pem  →  Verification: OK
// 這裡確認我們的驗證程式接受真實格式，離線也能跑。
describe('FreeTSA 真實回執（離線樣本）', () => {
  const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/freetsa-sample.json', import.meta.url), 'utf8')) as {
    root: string;
    receipt: string;
    issuedAt: string;
  };
  const token = Buffer.from(sample.receipt, 'base64');
  const options = { rootHex: sample.root, trustedRootsPem: [FREETSA_ROOT_CA_PEM] };

  it('用 FreeTSA 的根驗證通過，時間是 TSA 簽進回執的 genTime', () => {
    const verdict = verifyTimestampToken(token, options);
    expect(verdict).toMatchObject({ ok: true, nonce: BigInt('0x137e379902e546e2'), serial: BigInt('0x09de3311') });
    expect(verdict.ok && verdict.issuedAt.toISOString()).toBe('2026-11-09T06:54:56.000Z');
    expect(sample.issuedAt).toBe('2026-11-09T06:54:56.000Z');
  });

  it('雜湊不同：拒絕', () => {
    expect(verifyTimestampToken(token, { ...options, rootHex: '0'.repeat(64) })).toEqual({ ok: false, reason: '回執的雜湊與樹根不符' });
  });

  it('信任根不是 FreeTSA：拒絕', () => {
    expect(verifyTimestampToken(token, { ...options, trustedRootsPem: [TEST_ROOT_PEM] })).toEqual({
      ok: false,
      reason: '簽署憑證不在信任根之下',
    });
  });

  it('TSTInfo（含時間與序號）或簽章的任何一個位元組被改：拒絕', () => {
    // 從解析結果找出 TSTInfo 與簽章值在回執中的位置，逐位元組翻轉。SignedData 版本、摘要演算法清單
    // 這類不受簽章保護的欄位不在範圍內，驗證也不依賴它們
    const signedData = parseDer(token).children[1].children[0];
    const tst = signedData.children[2].children[1].children[0].value;
    const signerInfo = signedData.children.at(-1)!.children[0];
    const signature = signerInfo.children.find((c) => c.tag === 0x04)!.value;
    const regions = [tst, signature].map((r) => ({ start: token.indexOf(r), length: r.length }));
    expect(regions.every((r) => r.start > 0)).toBe(true);
    let checked = 0;
    for (const { start, length } of regions) {
      for (let at = start; at < start + length; at += 7) {
        const tampered = Buffer.from(token);
        tampered[at] ^= 0x01;
        expect(verifyTimestampToken(tampered, options).ok, `位移 ${at}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});
