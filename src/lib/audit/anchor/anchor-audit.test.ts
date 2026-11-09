import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestDb } from '../../pg/test-harness';
import { appendAudit } from '../append';
import { ORG_A, ORG_B, PLATFORM_ORG, createTestDb, openFixture, orgCtx, type AuditFixture } from '../audit-test-kit';
import { runAnchorAudit } from './anchor-audit';
import { memoryLogger, NOW, seedOrgs, writeEvents } from './anchor-test-kit';
import { verifyMerkleProof } from './merkle';
import { createMockAnchorProvider, type MockAnchorProvider } from './mock-provider';
import { listChainAnchors, listUnanchoredHeads, recordAnchor, recordAnchorFailure } from './store';
import { buildMerkleTree } from './merkle';

// anchor-audit（MIL-88，ADR-0019 決議 7、8、10）。PGlite，連線身分是 app_rw，RLS 生效。
// 外部服務用 Mock adapter。

describe('anchor-audit', () => {
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

  const run = (now = NOW) => runAnchorAudit({ withTx: f.withTx, provider, logger }, now);
  const control = <T>(fn: Parameters<typeof f.withTx<{ kind: 'control' }, T>>[1]) => f.withTx({ kind: 'control' }, fn);
  const anchorsOf = (orgId: string) => f.withTx(orgCtx(orgId), (tx) => listChainAnchors(tx));

  describe('沒有新事件時不呼叫外部服務', () => {
    it('完全沒有事件', async () => {
      expect(await run()).toEqual({ status: 'no_changes' });
      expect(provider.calls).toBe(0);
    });

    it('錨定過之後，所有鏈都沒有變動', async () => {
      await writeEvents(f, ORG_A, 3);
      await writeEvents(f, ORG_B, 2);
      expect((await run()).status).toBe('anchored');
      expect(provider.calls).toBe(1);

      expect(await run()).toEqual({ status: 'no_changes' });
      expect(provider.calls).toBe(1);
    });

    it('不產生葉：沒有新事件的鏈不在新批次裡', async () => {
      await writeEvents(f, ORG_A, 2);
      await writeEvents(f, ORG_B, 2);
      await run();
      await writeEvents(f, ORG_A, 1);
      const outcome = await run();

      expect(outcome).toMatchObject({ status: 'anchored', chains: 1 });
      expect((await anchorsOf(ORG_A)).map((a) => a.seq)).toEqual([2, 3]);
      expect((await anchorsOf(ORG_B)).map((a) => a.seq)).toEqual([2]);
    });
  });

  describe('保存回執與葉（P0-23 AC3）', () => {
    it('一批含所有有事件的鏈：葉記鏈、序號、鏈頭雜湊，回執來自服務商', async () => {
      const a = await writeEvents(f, ORG_A, 3);
      const b = await writeEvents(f, ORG_B, 2);
      // 平台鏈：沒有組織脈絡的事件
      const platform = await f.withTx({ kind: 'control' }, (tx) => appendAudit(tx, { action: 'tenant.login', actor: { type: 'system' } }));
      expect(platform.chainId).toBe(PLATFORM_ORG);

      const outcome = await run();
      expect(outcome).toMatchObject({ status: 'anchored', chains: 3, provider: 'mock' });

      const [anchorA] = await anchorsOf(ORG_A);
      const [anchorB] = await anchorsOf(ORG_B);
      expect(anchorA).toMatchObject({ provider: 'mock', seq: 3, headHash: a.hash });
      expect(anchorB).toMatchObject({ seq: 2, headHash: b.hash });
      expect(anchorA.root).toBe(anchorB.root);
      expect(anchorA.batchId).toBe(anchorB.batchId);
      expect(anchorA.issuedAt).toEqual(NOW);
      expect(anchorA.anchoredAt).toEqual(NOW);
      // 回執是服務商簽出的，驗得過
      expect(await provider.verify(anchorA.root, anchorA.receipt)).toEqual({ ok: true, issuedAt: NOW });
    });

    it('每個組織只憑自己的葉與證明就能推回樹根，且樹根等於獨立建出的 Merkle 樹', async () => {
      const a = await writeEvents(f, ORG_A, 3);
      const b = await writeEvents(f, ORG_B, 2);
      await run();
      const [anchorA] = await anchorsOf(ORG_A);
      const [anchorB] = await anchorsOf(ORG_B);

      const expected = buildMerkleTree([
        { chainId: ORG_A, seq: 3, headHash: a.hash },
        { chainId: ORG_B, seq: 2, headHash: b.hash },
      ]);
      expect(anchorA.root).toBe(expected.root);
      expect(verifyMerkleProof({ chainId: ORG_A, seq: anchorA.seq, headHash: anchorA.headHash }, anchorA.proof, anchorA.root)).toBe(true);
      expect(verifyMerkleProof({ chainId: ORG_B, seq: anchorB.seq, headHash: anchorB.headHash }, anchorB.proof, anchorB.root)).toBe(true);
    });

    it('時間來自參數：保存的 anchored_at 是傳入的 now，不是資料庫時鐘', async () => {
      await writeEvents(f, ORG_A, 1);
      const later = new Date('2031-01-02T03:04:05.000Z');
      await run(later);
      const [anchor] = await anchorsOf(ORG_A);
      expect(anchor.anchoredAt).toEqual(later);
    });
  });

  describe('錨定失敗時，稽核寫入繼續（ADR-0019 決議 10）', () => {
    it('失敗不寫葉，稽核照常寫入，下一次排程把失敗期間新增的事件一起送出', async () => {
      await writeEvents(f, ORG_A, 2);
      provider.failNext(1);
      const failed = await run();
      expect(failed).toMatchObject({ status: 'failed', consecutiveFailures: 1 });
      expect(await anchorsOf(ORG_A)).toEqual([]);

      // 失敗之後稽核仍可寫入
      const during = await writeEvents(f, ORG_A, 1);
      expect(during.seq).toBe(3);
      await writeEvents(f, ORG_B, 1);

      const retried = await run();
      expect(retried).toMatchObject({ status: 'anchored', chains: 2 });
      expect((await anchorsOf(ORG_A)).map((a) => a.seq)).toEqual([3]);
    });

    it('連續 2 次失敗寫 error 等級 log，第 1 次只寫警告', async () => {
      await writeEvents(f, ORG_A, 1);
      provider.failNext(2);

      expect(await run()).toMatchObject({ status: 'failed', consecutiveFailures: 1 });
      expect(logger.of('ERROR')).toHaveLength(0);
      expect(logger.of('WARNING')).toHaveLength(1);

      expect(await run()).toMatchObject({ status: 'failed', consecutiveFailures: 2 });
      expect(logger.of('ERROR')).toHaveLength(1);
      expect(logger.of('ERROR')[0].fields).toMatchObject({ consecutiveFailures: 2, provider: 'mock' });
    });

    it('成功一次就把連續失敗歸零', async () => {
      await writeEvents(f, ORG_A, 1);
      provider.failNext(1);
      await run(); // 失敗 1
      await run(); // 成功
      await writeEvents(f, ORG_A, 1);
      provider.failNext(1);
      expect(await run()).toMatchObject({ status: 'failed', consecutiveFailures: 1 });
      expect(logger.of('ERROR')).toHaveLength(0);
    });

    it('失敗紀錄與 log 都不含事件內容，只有服務商的錯誤訊息', async () => {
      await writeEvents(f, ORG_A, 1);
      provider.failNext(1);
      const outcome = await run();
      expect(outcome).toMatchObject({ status: 'failed', error: 'Mock 錨定服務：模擬中斷' });
      expect(JSON.stringify(logger.entries)).not.toContain('ledger');
    });
  });

  describe('兩個排程同時執行', () => {
    it('後到的發現鏈頭已被前一批涵蓋：回報 superseded，不算失敗，也不留下第二批', async () => {
      await writeEvents(f, ORG_A, 2);
      let nested: Awaited<ReturnType<typeof run>> | undefined;
      const racing = {
        ...provider,
        id: 'mock',
        verify: provider.verify,
        // 外部服務回應的空檔，另一個排程已經完成整個流程
        anchor: async (root: string) => {
          if (!nested) nested = await run();
          return provider.anchor(root);
        },
      };
      const outcome = await runAnchorAudit({ withTx: f.withTx, provider: racing, logger }, NOW);

      expect(nested?.status).toBe('anchored');
      expect(outcome).toEqual({ status: 'superseded' });
      expect(await anchorsOf(ORG_A)).toHaveLength(1);
      expect(logger.entries).toEqual([]);
      // 沒有計入失敗：下一次失敗仍從 1 開始
      expect(await control((tx) => recordAnchorFailure(tx, NOW, 'x'))).toBe(1);
    });
  });

  describe('讀取鏈頭與寫入錨定只經定義者函式', () => {
    it('app_rw 不能直接讀寫三張錨定表', async () => {
      await writeEvents(f, ORG_A, 1);
      await run();
      for (const table of ['anchor_batches', 'anchor_leaves', 'anchor_runs']) {
        await expect(f.db.query(`SELECT * FROM audit.${table}`)).rejects.toThrow(/permission denied/);
        await expect(f.db.query(`DELETE FROM audit.${table}`)).rejects.toThrow(/permission denied/);
        await expect(f.db.query(`TRUNCATE audit.${table}`)).rejects.toThrow(/permission denied/);
      }
      await expect(
        f.db.query(`INSERT INTO audit.anchor_runs (ran_at, outcome, error) VALUES (now(), 'failed', 'x')`),
      ).rejects.toThrow(/permission denied/);
    });

    it('未錨定鏈頭的函式只回傳鏈、序號、雜湊三個欄位', async () => {
      const a = await writeEvents(f, ORG_A, 2);
      const { rows } = await f.db.query<Record<string, unknown>>('SELECT * FROM audit.unanchored_heads()');
      expect(rows).toEqual([{ chain_id: ORG_A, seq: expect.anything(), hash: a.hash }]);
      expect(Object.keys(rows[0]).sort()).toEqual(['chain_id', 'hash', 'seq']);
    });

    it('錨定查詢的函式欄位沒有事件內容', async () => {
      await writeEvents(f, ORG_A, 1);
      await run();
      const { rows } = await f.withTx(orgCtx(ORG_A), (tx) => tx.query<Record<string, unknown>>('SELECT * FROM audit.chain_anchors()'));
      expect(Object.keys(rows[0]).sort()).toEqual(['anchored_at', 'batch_id', 'head_hash', 'issued_at', 'proof', 'provider', 'receipt', 'root', 'seq']);
    });

    it('chain_anchors 只回自己這條鏈的葉；沒有組織脈絡時是平台鏈（沒有葉）', async () => {
      await writeEvents(f, ORG_A, 1);
      await writeEvents(f, ORG_B, 1);
      await run();
      expect((await anchorsOf(ORG_A)).map((a) => a.seq)).toEqual([1]);
      expect(await control(async (tx) => (await tx.query('SELECT * FROM audit.chain_anchors()')).rows)).toEqual([]);
    });

    it('record_anchor 拒絕對不上事件的葉，也拒絕空的葉', async () => {
      const a = await writeEvents(f, ORG_A, 1);
      const bogus = buildMerkleTree([{ chainId: ORG_A, seq: 1, headHash: 'f'.repeat(64) }]);
      await expect(
        control((tx) => recordAnchor(tx, { at: NOW, provider: 'mock', root: bogus.root, receipt: 'cg==', issuedAt: NOW, leaves: bogus.leaves })),
      ).rejects.toMatchObject({ code: 'AU002' });

      const ok = buildMerkleTree([{ chainId: ORG_A, seq: 1, headHash: a.hash }]);
      await expect(
        control((tx) => recordAnchor(tx, { at: NOW, provider: 'mock', root: ok.root, receipt: 'cg==', issuedAt: NOW, leaves: [] })),
      ).rejects.toThrow(/至少要有一片葉/);
    });

    it('同一個序號不能再錨定一次（AU001）', async () => {
      const a = await writeEvents(f, ORG_A, 1);
      const tree = buildMerkleTree([{ chainId: ORG_A, seq: 1, headHash: a.hash }]);
      const input = { at: NOW, provider: 'mock', root: tree.root, receipt: 'cg==', issuedAt: NOW, leaves: tree.leaves };
      await control((tx) => recordAnchor(tx, input));
      await expect(control((tx) => recordAnchor(tx, input))).rejects.toMatchObject({ code: 'AU001' });
      expect(await control(listUnanchoredHeads)).toEqual([]);
    });

    it('錨定表只增不改：擁有者與超級使用者之外，觸發器也擋 UPDATE、DELETE、TRUNCATE', async () => {
      await writeEvents(f, ORG_A, 1);
      await run();
      await f.db.exec('RESET ROLE');
      try {
        for (const table of ['anchor_batches', 'anchor_leaves', 'anchor_runs']) {
          await expect(f.db.query(`UPDATE audit.${table} SET ${table === 'anchor_runs' ? 'error' : table === 'anchor_leaves' ? 'head_hash' : 'receipt'} = NULL`)).rejects.toThrow(/只增不改/);
          await expect(f.db.query(`DELETE FROM audit.${table}`)).rejects.toThrow(/只增不改/);
          await expect(f.db.query(`TRUNCATE audit.${table} CASCADE`)).rejects.toThrow(/只增不改/);
        }
      } finally {
        await f.db.exec('SET ROLE app_rw');
      }
    });
  });
});
