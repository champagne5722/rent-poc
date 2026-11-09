import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit } from '../audit/append';
import { createMockAnchorProvider } from '../audit/anchor/mock-provider';
import { memoryLogger, rewriteWholeChain } from '../audit/anchor/anchor-test-kit';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { handleJobRequest } from './handler';
import { createJobs, type JobTable } from './jobs';
import type { OidcConfig } from './oidc';
import { createTimerRegistry } from './timers/registry';

// anchor-audit 與 verify-audit 經 createJobs 與 POST /api/internal/jobs/:name 的接線（MIL-88）。
// 業務邏輯的測試在 src/lib/audit/anchor/。這裡只確認註冊、時間參數與回應形狀。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const NOW = new Date('2026-11-10T03:00:00.000Z');
const noSigning = { drainInbox: async () => [], drainOutbox: async () => [] };
const noEmails = { drainEmails: async () => [] };

function setup(options: { audit?: boolean } = { audit: true }) {
  const provider = createMockAnchorProvider({ now: () => NOW });
  const logger = memoryLogger();
  const jobs = createJobs({
    signing: noSigning,
    notifications: noEmails,
    timers: createTimerRegistry(),
    ...(options.audit ? { audit: { providers: () => ({ primary: provider, byId: { mock: provider } }), logger } } : {}),
  });
  return { provider, logger, jobs };
}

const write = (orgId: string, n: number) =>
  withTx({ kind: 'org', orgId }, async (tx) => {
    for (let i = 0; i < n; i++) await appendAudit(tx, { action: 'ledger.entry', object: { type: 'ledger', id: `L-${i}` } });
  });

describe('稽核 job 的註冊', () => {
  it('提供錨定服務時註冊 anchor-audit 與 verify-audit', () => {
    expect(Object.keys(setup().jobs).sort()).toEqual(['anchor-audit', 'drain-inbox', 'drain-outbox', 'migrate-contracts-to-cases', 'scan-timers', 'verify-audit']);
  });

  it('沒有提供時不註冊，其他 job 不受影響', async () => {
    const { jobs } = setup({});
    expect(Object.keys(jobs).sort()).toEqual(['drain-inbox', 'drain-outbox', 'migrate-contracts-to-cases', 'scan-timers']);
  });
});

describe('anchor-audit', () => {
  it('沒有新事件：回 no_changes，不呼叫外部服務', async () => {
    const { jobs, provider } = setup();
    expect(await jobs['anchor-audit']({ now: NOW })).toEqual({ status: 'no_changes' });
    expect(provider.calls).toBe(0);
  });

  it('有新事件：錨定並回傳批次，時間是排程傳入的 now', async () => {
    await write(kit.orgA, 2);
    const { jobs, provider } = setup();
    const result = await jobs['anchor-audit']({ now: NOW });
    expect(result).toMatchObject({ status: 'anchored', chains: 1, provider: 'mock', issuedAt: NOW.toISOString() });
    expect(provider.calls).toBe(1);
  });

  it('外部服務失敗：job 回結果而不是丟錯，路由回 200', async () => {
    await write(kit.orgA, 1);
    const { jobs, provider } = setup();
    provider.failNext(1);
    expect(await jobs['anchor-audit']({ now: NOW })).toMatchObject({ status: 'failed', consecutiveFailures: 1 });
  });
});

describe('verify-audit', () => {
  it('沒有問題時回計數', async () => {
    await write(kit.orgA, 2);
    const { jobs } = setup();
    await jobs['anchor-audit']({ now: NOW });
    expect(await jobs['verify-audit']({ now: NOW })).toMatchObject({ failed: [], errors: 0, anchorsChecked: 1, checkedAt: NOW.toISOString() });
  });

  it('超級使用者重算整條鏈後：回結果列出問題的鏈，並寫最高等級 log', async () => {
    await write(kit.orgA, 4);
    const { jobs, logger } = setup();
    await jobs['anchor-audit']({ now: NOW });
    await kit.asOwner(async (db) => {
      await db.exec('RESET ROLE');
      try {
        await rewriteWholeChain(db, kit.orgA);
      } finally {
        await db.exec('SET ROLE app_owner');
      }
    });
    const result = await jobs['verify-audit']({ now: NOW });
    expect(result).toMatchObject({ failed: [{ chainId: kit.orgA, local: [], anchors: ['anchored_hash_mismatch@4'] }] });
    expect(logger.of('CRITICAL')).toHaveLength(1);
  });
});

describe('路由（POST /api/internal/jobs/:name）', () => {
  const CONFIG: OidcConfig = { audience: 'https://rent-poc-demo.example.run.app', serviceAccount: 'scheduler@rent-poc.iam.gserviceaccount.com' };
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const nowS = Math.floor(NOW.getTime() / 1000);
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const token = () => {
    const data = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64({
      iss: 'https://accounts.google.com',
      aud: CONFIG.audience,
      email: CONFIG.serviceAccount,
      email_verified: true,
      iat: nowS,
      exp: nowS + 3600,
    })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(data);
    return `${data}.${signer.sign(keys.privateKey).toString('base64url')}`;
  };
  const post = (jobs: JobTable, name: string, authorization: string | null) =>
    handleJobRequest(
      new Request(`${CONFIG.audience}/api/internal/jobs/${name}`, { method: 'POST', headers: authorization ? { authorization } : {} }),
      name,
      { config: CONFIG, keys: async () => keys.publicKey.export({ format: 'jwk' }), jobs, now: () => NOW },
    );

  it('驗證通過後執行 anchor-audit，回 200 與結果', async () => {
    await write(kit.orgA, 1);
    const { jobs } = setup();
    const response = await post(jobs, 'anchor-audit', `Bearer ${token()}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ job: 'anchor-audit', result: { status: 'anchored' } });
  });

  it('沒有 token：401，外部服務一次都不能被呼叫', async () => {
    await write(kit.orgA, 1);
    const { jobs, provider } = setup();
    expect((await post(jobs, 'anchor-audit', null)).status).toBe(401);
    expect((await post(jobs, 'verify-audit', null)).status).toBe(401);
    expect(provider.calls).toBe(0);
  });

  it('沒有提供錨定服務時，兩個名稱都回 404', async () => {
    const { jobs } = setup({});
    expect((await post(jobs, 'anchor-audit', `Bearer ${token()}`)).status).toBe(404);
    expect((await post(jobs, 'verify-audit', `Bearer ${token()}`)).status).toBe(404);
  });
});
