import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bearerToken, createGoogleKeySource, oidcConfigFromEnv, verifyOidcToken, type OidcConfig } from './oidc';

// 內部 job route 的呼叫者驗證（ADR-0020 決議 2）：Cloud Scheduler 帶的 Google OIDC token。
// 簽章、aud、service account 三項都要通過。測試自己產生金鑰與 token，不連網。

const CONFIG: OidcConfig = {
  audience: 'https://rent-poc-demo.example.run.app/api/internal/jobs',
  serviceAccount: 'scheduler@rent-poc.iam.gserviceaccount.com',
};
const NOW_MS = Date.UTC(2026, 10, 9, 3, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);

const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const goodKeys = pair();
const otherKeys = pair();
const jwkOf = (key: KeyObject) => key.export({ format: 'jwk' });

const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function sign(
  payload: Record<string, unknown>,
  opts: { privateKey?: KeyObject; header?: Record<string, unknown> } = {},
): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'key-1', ...opts.header };
  const data = `${b64(header)}.${b64(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(data);
  return `${data}.${signer.sign(opts.privateKey ?? goodKeys.privateKey).toString('base64url')}`;
}

const validPayload = (over: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CONFIG.audience,
  email: CONFIG.serviceAccount,
  email_verified: true,
  iat: NOW_S - 10,
  exp: NOW_S + 3000,
  ...over,
});

const keys = { 'key-1': jwkOf(goodKeys.publicKey) } as Record<string, JsonWebKey>;
const deps = {
  now: () => NOW_MS,
  keys: async (kid: string) => keys[kid],
};

describe('verifyOidcToken', () => {
  it('簽章、aud、service account 都正確：通過，回傳 service account', async () => {
    await expect(verifyOidcToken(sign(validPayload()), CONFIG, deps)).resolves.toEqual({
      ok: true,
      email: CONFIG.serviceAccount,
    });
  });

  it('簽章不是 Google 金鑰簽的：拒絕', async () => {
    const forged = sign(validPayload(), { privateKey: otherKeys.privateKey });
    await expect(verifyOidcToken(forged, CONFIG, deps)).resolves.toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('payload 被改過（簽章不再吻合）：拒絕', async () => {
    const [h, , s] = sign(validPayload()).split('.');
    const tampered = `${h}.${b64(validPayload({ email: 'attacker@evil.example' }))}.${s}`;
    await expect(verifyOidcToken(tampered, CONFIG, deps)).resolves.toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('aud 不符：拒絕。token 不能拿來打別的服務', async () => {
    const token = sign(validPayload({ aud: 'https://other.example.run.app' }));
    await expect(verifyOidcToken(token, CONFIG, deps)).resolves.toMatchObject({ ok: false, reason: 'bad_audience' });
  });

  it('aud 是陣列時，必須包含設定的 aud', async () => {
    await expect(verifyOidcToken(sign(validPayload({ aud: ['x', CONFIG.audience] })), CONFIG, deps)).resolves.toMatchObject({ ok: true });
    await expect(verifyOidcToken(sign(validPayload({ aud: ['x', 'y'] })), CONFIG, deps)).resolves.toMatchObject({
      ok: false,
      reason: 'bad_audience',
    });
  });

  it('service account 不符：拒絕。別的 Google 帳號簽發的 token 不算', async () => {
    const token = sign(validPayload({ email: 'someone@gmail.com' }));
    await expect(verifyOidcToken(token, CONFIG, deps)).resolves.toMatchObject({ ok: false, reason: 'bad_service_account' });
  });

  it('email 未驗證：拒絕', async () => {
    const token = sign(validPayload({ email_verified: false }));
    await expect(verifyOidcToken(token, CONFIG, deps)).resolves.toMatchObject({ ok: false, reason: 'bad_service_account' });
  });

  it('簽發者不是 Google：拒絕', async () => {
    const token = sign(validPayload({ iss: 'https://evil.example' }));
    await expect(verifyOidcToken(token, CONFIG, deps)).resolves.toMatchObject({ ok: false, reason: 'bad_issuer' });
  });

  it('已過期：拒絕。容許 60 秒的時鐘誤差', async () => {
    await expect(verifyOidcToken(sign(validPayload({ exp: NOW_S - 120 })), CONFIG, deps)).resolves.toMatchObject({
      ok: false,
      reason: 'expired',
    });
    await expect(verifyOidcToken(sign(validPayload({ exp: NOW_S - 30 })), CONFIG, deps)).resolves.toMatchObject({ ok: true });
  });

  it('還沒生效（nbf、iat 在未來）：拒絕', async () => {
    await expect(verifyOidcToken(sign(validPayload({ nbf: NOW_S + 600 })), CONFIG, deps)).resolves.toMatchObject({
      ok: false,
      reason: 'not_yet_valid',
    });
    await expect(verifyOidcToken(sign(validPayload({ iat: NOW_S + 600 })), CONFIG, deps)).resolves.toMatchObject({
      ok: false,
      reason: 'not_yet_valid',
    });
  });

  it('沒有 exp：拒絕', async () => {
    const payload: Record<string, unknown> = validPayload();
    delete payload.exp;
    await expect(verifyOidcToken(sign(payload), CONFIG, deps)).resolves.toMatchObject({ ok: false, reason: 'expired' });
  });

  it('alg 不是 RS256 一律拒絕，包含 none 與 HS256', async () => {
    const none = `${b64({ alg: 'none', typ: 'JWT', kid: 'key-1' })}.${b64(validPayload())}.`;
    await expect(verifyOidcToken(none, CONFIG, deps)).resolves.toMatchObject({ ok: false, reason: 'bad_algorithm' });
    const hs = sign(validPayload(), { header: { alg: 'HS256' } });
    await expect(verifyOidcToken(hs, CONFIG, deps)).resolves.toMatchObject({ ok: false, reason: 'bad_algorithm' });
  });

  it('找不到 kid 對應的金鑰：拒絕', async () => {
    const token = sign(validPayload(), { header: { kid: 'unknown' } });
    await expect(verifyOidcToken(token, CONFIG, deps)).resolves.toMatchObject({ ok: false, reason: 'unknown_key' });
  });

  it('不是 JWT 的字串：拒絕，不丟例外', async () => {
    for (const token of ['', 'abc', 'a.b', 'a.b.c', '....']) {
      await expect(verifyOidcToken(token, CONFIG, deps)).resolves.toMatchObject({ ok: false });
    }
  });

  it('取不到 Google 的金鑰（暫時性）：回 keys_unavailable，與驗證失敗分開', async () => {
    const down = {
      now: deps.now,
      keys: async () => {
        throw new Error('network down');
      },
    };
    await expect(verifyOidcToken(sign(validPayload()), CONFIG, down)).resolves.toEqual({ ok: false, reason: 'keys_unavailable' });
  });
});

describe('bearerToken', () => {
  it('取出 Authorization 標頭的 Bearer token', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer abc')).toBe('abc');
  });
  it('其他形式回 null', () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
  });
});

describe('Google 金鑰來源', () => {
  const jwk = (kid: string) => ({ ...jwkOf(goodKeys.publicKey), kid });

  it('金鑰快取：連續查詢只抓一次', async () => {
    let calls = 0;
    let clock = 0;
    const source = createGoogleKeySource({
      now: () => clock,
      fetchCerts: async () => {
        calls++;
        return [jwk('k1')];
      },
    });
    expect(await source('k1')).toMatchObject({ kid: 'k1' });
    clock += 1000;
    expect(await source('k1')).toMatchObject({ kid: 'k1' });
    expect(calls).toBe(1);
  });

  it('輪替當下遇到新的 kid 會重抓一次，但亂填 kid 的請求不會連續打 Google', async () => {
    let published = [jwk('k1')];
    let calls = 0;
    let clock = 0;
    const source = createGoogleKeySource({
      now: () => clock,
      fetchCerts: async () => {
        calls++;
        return published;
      },
    });
    await source('k1');
    // 剛抓過，查不認得的 kid：不重抓
    clock += 1000;
    expect(await source('bogus')).toBeUndefined();
    expect(calls).toBe(1);
    // 過了最短間隔，Google 已輪替：重抓後找得到
    clock += 61_000;
    published = [jwk('k1'), jwk('k2')];
    expect(await source('k2')).toMatchObject({ kid: 'k2' });
    expect(calls).toBe(2);
  });

  it('超過快取時間重抓', async () => {
    let calls = 0;
    let clock = 0;
    const source = createGoogleKeySource({
      now: () => clock,
      fetchCerts: async () => {
        calls++;
        return [jwk('k1')];
      },
    });
    await source('k1');
    clock += 61 * 60 * 1000;
    await source('k1');
    expect(calls).toBe(2);
  });
});

describe('oidcConfigFromEnv', () => {
  it('兩個變數都有才算設定完成', () => {
    expect(oidcConfigFromEnv({ JOBS_OIDC_AUDIENCE: 'a', JOBS_OIDC_SERVICE_ACCOUNT: 'b@x' } as unknown as NodeJS.ProcessEnv)).toEqual({
      audience: 'a',
      serviceAccount: 'b@x',
    });
    expect(oidcConfigFromEnv({ JOBS_OIDC_AUDIENCE: 'a' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(oidcConfigFromEnv({ JOBS_OIDC_AUDIENCE: ' ', JOBS_OIDC_SERVICE_ACCOUNT: 'b' } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});
