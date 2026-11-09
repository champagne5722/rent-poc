import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestDb } from '../../pg/test-harness';
import type { DbContext } from '../../pg/with-tx';
import { ORG_A, ORG_B, PLATFORM_ORG, asSuperuser, createTestDb, openFixture, orgCtx, type AuditFixture } from '../audit-test-kit';
import { appendAudit } from '../append';
import { runAnchorAudit } from './anchor-audit';
import { memoryLogger, NOW, rewriteWholeChain, seedOrgs, tamperAnchors, writeEvents } from './anchor-test-kit';
import { createMockAnchorProvider, type MockAnchorProvider } from './mock-provider';
import type { AnchorProvider } from './provider';
import { runVerifyAudit, verifyChainAnchors } from './verify-audit';

const DEFAULT_ORG = '00000000000000000000000002'; // 種子的預設組織（0002_control_orgs.sql），control.orgs 裡一起列出

// verify-audit（MIL-88，ADR-0019 決議 13，P0-23 AC4）。逐組織 set_config 驗證本地鏈與已存的葉、證明、回執。
// 竄改一律用超級使用者並關掉觸發器，模擬資料庫被入侵。

describe('verify-audit', () => {
  let testDb: TestDb;
  let f: AuditFixture;
  let provider: MockAnchorProvider;
  let logger: ReturnType<typeof memoryLogger>;

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    f = await openFixture(testDb);
    await seedOrgs(f);
    provider = createMockAnchorProvider({ now: () => NOW });
    logger = memoryLogger();
  });
  afterEach(() => f.close());

  const anchor = () => runAnchorAudit({ withTx: f.withTx, provider, logger }, NOW);
  const verify = (providers: Record<string, AnchorProvider> = { mock: provider }) =>
    runVerifyAudit({ withTx: f.withTx, providers, logger }, NOW);
  const chainReport = (orgId: string, providers: Record<string, AnchorProvider> = { mock: provider }) =>
    f.withTx(orgCtx(orgId), (tx) => verifyChainAnchors(tx, providers));
  const kinds = async (orgId: string) => (await chainReport(orgId)).issues.map((i) => `${i.kind}@${i.seq}`);

  describe('沒被動過', () => {
    it('四條鏈（平台、預設組織、A、B）都通過，檢查過的葉數量正確，不寫任何 log', async () => {
      await writeEvents(f, ORG_A, 3);
      await writeEvents(f, ORG_B, 2);
      await f.withTx({ kind: 'control' }, (tx) => appendAudit(tx, { action: 'tenant.login', actor: { type: 'system' } }));
      await anchor();
      await writeEvents(f, ORG_A, 1);
      await anchor();

      const result = await verify();
      expect(result).toEqual({ chains: 4, ok: 4, failed: [], errors: 0, anchorsChecked: 4, checkedAt: NOW.toISOString() });
      expect(logger.entries).toEqual([]);
    });

    it('還沒有任何錨定的鏈：本地鏈通過就算通過，沒有葉可比對', async () => {
      await writeEvents(f, ORG_A, 2);
      expect(await verify()).toMatchObject({ chains: 4, ok: 4, anchorsChecked: 0 });
    });

    it('錨定之後又寫了新事件：新事件還沒被涵蓋，不算問題', async () => {
      await writeEvents(f, ORG_A, 2);
      await anchor();
      await writeEvents(f, ORG_A, 5);
      expect(await verify()).toMatchObject({ ok: 4, failed: [] });
    });
  });

  describe('超級使用者重算整條鏈後（P0-23 AC4）', () => {
    it('本地驗證仍通過，但葉的雜湊對不上：寫最高等級 log', async () => {
      await writeEvents(f, ORG_A, 4);
      await writeEvents(f, ORG_B, 2);
      await anchor();
      await rewriteWholeChain(f.db, ORG_A);

      const result = await verify();

      expect(result.failed).toEqual([{ chainId: ORG_A, local: [], anchors: ['anchored_hash_mismatch@4'] }]);
      expect(result).toMatchObject({ chains: 4, ok: 3 });
      const critical = logger.of('CRITICAL');
      expect(critical).toHaveLength(1);
      expect(critical[0].fields).toMatchObject({ chainId: ORG_A, anchorIssues: ['anchored_hash_mismatch@4'], localIssues: [] });
      // log 不含事件內容
      expect(JSON.stringify(critical)).not.toContain('member.grant');
    });

    it('沒有錨定之前，同樣的竄改抓不到（ADR-0019 Consequences：未錨定的窗口）', async () => {
      await writeEvents(f, ORG_A, 4);
      await rewriteWholeChain(f.db, ORG_A);
      expect(await verify()).toMatchObject({ ok: 4, failed: [] });
    });

    it('只在竄改點之後才錨定的葉也對不上時才報；竄改點之前的葉仍符合', async () => {
      await writeEvents(f, ORG_A, 1); // seq 1 先錨定，之後的重算從 seq 2 起改，seq 1 不變
      await anchor();
      await writeEvents(f, ORG_A, 3);
      await anchor();
      await rewriteWholeChain(f.db, ORG_A);
      expect(await kinds(ORG_A)).toEqual(['anchored_hash_mismatch@4']);
    });
  });

  describe('其他竄改', () => {
    it('鏈被截斷：被錨定的事件不見了', async () => {
      await writeEvents(f, ORG_A, 3);
      await anchor();
      await asSuperuser(f.db, async () => {
        await f.db.exec('ALTER TABLE audit.events DISABLE TRIGGER USER');
        await f.db.query(`DELETE FROM audit.events WHERE chain_id = $1 AND seq = 3`, [ORG_A]);
        await f.db.exec('ALTER TABLE audit.events ENABLE TRIGGER USER');
      });
      const report = await chainReport(ORG_A);
      expect(report.issues.map((i) => i.kind)).toEqual(['anchored_event_missing']);
    });

    it('回執被換掉：回執驗證失敗', async () => {
      await writeEvents(f, ORG_A, 2);
      await anchor();
      await tamperAnchors(f.db, 'anchor_batches', () =>
        f.db.query(`UPDATE audit.anchor_batches SET receipt = $1`, [Buffer.from(JSON.stringify({ mock: 1, root: 'f'.repeat(64), at: NOW.toISOString() })).toString('base64')]),
      );
      expect(await kinds(ORG_A)).toEqual(['anchor_receipt_invalid@2']);
    });

    it('證明被改：Merkle 證明推不回樹根', async () => {
      await writeEvents(f, ORG_A, 2);
      await writeEvents(f, ORG_B, 2);
      await anchor();
      await tamperAnchors(f.db, 'anchor_leaves', () =>
        f.db.query(`UPDATE audit.anchor_leaves SET proof = $1::jsonb WHERE chain_id = $2`, [JSON.stringify([{ side: 'left', hash: 'a'.repeat(64) }]), ORG_A]),
      );
      expect(await kinds(ORG_A)).toEqual(['anchor_proof_invalid@2']);
      expect(await kinds(ORG_B)).toEqual([]);
    });

    it('樹根被改（葉與回執都沒動）：證明推不回樹根，回執也不符', async () => {
      await writeEvents(f, ORG_A, 2);
      await anchor();
      await tamperAnchors(f.db, 'anchor_batches', () => f.db.query(`UPDATE audit.anchor_batches SET root = $1`, ['c'.repeat(64)]));
      expect((await kinds(ORG_A)).sort()).toEqual(['anchor_proof_invalid@2', 'anchor_receipt_invalid@2']);
    });

    it('服務商不在登錄表：回報 anchor_provider_unknown，不當成通過', async () => {
      await writeEvents(f, ORG_A, 1);
      await anchor();
      expect((await chainReport(ORG_A, {})).issues.map((i) => i.kind)).toEqual(['anchor_provider_unknown']);
    });

    it('本地鏈本身壞了（只改欄位不改 canonical）：local 有問題，一樣寫最高等級 log', async () => {
      await writeEvents(f, ORG_A, 2);
      await asSuperuser(f.db, async () => {
        await f.db.exec('ALTER TABLE audit.events DISABLE TRIGGER USER');
        await f.db.query(`UPDATE audit.events SET action = 'member.grant' WHERE chain_id = $1 AND seq = 1`, [ORG_A]);
        await f.db.exec('ALTER TABLE audit.events ENABLE TRIGGER USER');
      });
      const result = await verify();
      expect(result.failed).toEqual([{ chainId: ORG_A, local: ['canonical_mismatch@1'], anchors: [] }]);
      expect(logger.of('CRITICAL')).toHaveLength(1);
    });
  });

  describe('逐組織驗證，不用跨組織的讀取權限', () => {
    it('只開 control 交易（列組織）與每條鏈一個 org 交易，沒有 operator 脈絡', async () => {
      await writeEvents(f, ORG_A, 1);
      const seen: DbContext[] = [];
      const spying = ((ctx: DbContext, fn: never) => {
        seen.push(ctx);
        return f.withTx(ctx as never, fn);
      }) as typeof f.withTx;
      await runVerifyAudit({ withTx: spying, providers: { mock: provider }, logger }, NOW);

      expect(seen[0]).toEqual({ kind: 'control' });
      expect(seen.slice(1)).toEqual([orgCtx(PLATFORM_ORG), orgCtx(DEFAULT_ORG), orgCtx(ORG_A), orgCtx(ORG_B)]);
    });

    it('一條鏈的驗證丟錯，不影響其他鏈；錯誤計入 errors 並寫 ERROR log', async () => {
      await writeEvents(f, ORG_A, 1);
      await writeEvents(f, ORG_B, 1);
      const flaky = ((ctx: DbContext, fn: never) => {
        if (ctx.kind === 'org' && ctx.orgId === ORG_A) return Promise.reject(new Error('連線中斷'));
        return f.withTx(ctx as never, fn);
      }) as typeof f.withTx;
      const result = await runVerifyAudit({ withTx: flaky, providers: { mock: provider }, logger }, NOW);

      expect(result).toMatchObject({ chains: 4, ok: 3, errors: 1, failed: [] });
      expect(logger.of('ERROR')).toHaveLength(1);
      expect(logger.of('ERROR')[0].fields).toMatchObject({ chainId: ORG_A, error: '連線中斷' });
    });

    it('A 的脈絡只看得到 A 的葉，驗證不需要 B 的任何資料', async () => {
      await writeEvents(f, ORG_A, 1);
      await writeEvents(f, ORG_B, 1);
      await anchor();
      const reportA = await chainReport(ORG_A);
      expect(reportA).toMatchObject({ chainId: ORG_A, anchorsChecked: 1, issues: [] });
    });
  });
});
