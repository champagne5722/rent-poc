import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleJobRequest, type JobRouteDeps } from './handler';
import type { JobTable } from './jobs';
import type { OidcConfig } from './oidc';

// POST /api/internal/jobs/:name（ADR-0020 決議 1、2）。驗證失敗回 401，而且 job 一次都不能執行。

const CONFIG: OidcConfig = {
  audience: 'https://rent-poc-demo.example.run.app',
  serviceAccount: 'scheduler@rent-poc.iam.gserviceaccount.com',
};
const NOW = new Date('2026-11-09T03:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

const goodKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function tokenFor(over: Record<string, unknown> = {}, signingKey: KeyObject = goodKeys.privateKey): string {
  const data = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64({
    iss: 'https://accounts.google.com',
    aud: CONFIG.audience,
    email: CONFIG.serviceAccount,
    email_verified: true,
    iat: NOW_S,
    exp: NOW_S + 3600,
    ...over,
  })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(data);
  return `${data}.${signer.sign(signingKey).toString('base64url')}`;
}

const run = vi.fn(async () => ({ processed: 2 }));
const jobs: JobTable = { 'drain-inbox': run };

const deps = (over: Partial<JobRouteDeps> = {}): JobRouteDeps => ({
  config: CONFIG,
  keys: async (kid) => (kid === 'k1' ? goodKeys.publicKey.export({ format: 'jwk' }) : undefined),
  jobs,
  now: () => NOW,
  ...over,
});

const post = (name: string, authorization: string | null, d = deps()) =>
  handleJobRequest(
    new Request(`https://rent-poc-demo.example.run.app/api/internal/jobs/${name}`, {
      method: 'POST',
      headers: authorization ? { authorization } : {},
    }),
    name,
    d,
  );

beforeEach(() => {
  run.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('驗證通過', () => {
  it('執行 job，回 200 與 job 的結果；現在時間由 route 傳入', async () => {
    const response = await post('drain-inbox', `Bearer ${tokenFor()}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ job: 'drain-inbox', result: { processed: 2 } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ now: NOW });
  });
});

describe('驗證失敗：回 401，job 不執行', () => {
  it.each([
    ['沒有 Authorization 標頭', () => null],
    ['不是 Bearer（Basic Auth 擋不住它，route 自己要擋）', () => 'Basic ZGVtbzpwYXNz'],
    ['Bearer 後面不是 JWT', () => 'Bearer abc'],
    ['簽章不是 Google 金鑰簽的', () => `Bearer ${tokenFor({}, otherKeys.privateKey)}`],
    ['aud 不符', () => `Bearer ${tokenFor({ aud: 'https://other.example.run.app' })}`],
    ['service account 不符', () => `Bearer ${tokenFor({ email: 'attacker@evil.example' })}`],
    ['已過期', () => `Bearer ${tokenFor({ iat: NOW_S - 7200, exp: NOW_S - 3600 })}`],
  ])('%s', async (_label, authorization) => {
    const response = await post('drain-inbox', authorization());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: '未授權' });
    expect(run).not.toHaveBeenCalled();
  });

  it('不論 job 存在與否，驗證失敗都回 401，不洩漏哪些 job 存在', async () => {
    expect((await post('no-such-job', null)).status).toBe(401);
    expect((await post('constructor', null)).status).toBe(401);
  });
});

describe('其他情況', () => {
  it('沒有設定驗證（環境變數缺少）：回 503，job 不執行，即使帶了看似有效的 token', async () => {
    const response = await post('drain-inbox', `Bearer ${tokenFor()}`, deps({ config: null }));

    expect(response.status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });

  it('取不到 Google 的金鑰：回 503 讓排程重試，job 不執行', async () => {
    const response = await post(
      'drain-inbox',
      `Bearer ${tokenFor()}`,
      deps({
        keys: async () => {
          throw new Error('network');
        },
      }),
    );

    expect(response.status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });

  it('驗證通過但沒有這個 job：404。原型鏈上的名稱也一樣', async () => {
    expect((await post('no-such-job', `Bearer ${tokenFor()}`)).status).toBe(404);
    expect((await post('constructor', `Bearer ${tokenFor()}`)).status).toBe(404);
    expect((await post('__proto__', `Bearer ${tokenFor()}`)).status).toBe(404);
  });

  it('job 丟例外：回 500，不把內部訊息傳給呼叫端', async () => {
    const failing: JobTable = {
      'drain-inbox': async () => {
        throw new Error('資料庫密碼是 hunter2');
      },
    };

    const response = await post('drain-inbox', `Bearer ${tokenFor()}`, deps({ jobs: failing }));

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('hunter2');
  });
});
