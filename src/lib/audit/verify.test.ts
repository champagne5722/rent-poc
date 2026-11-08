import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestDb } from '../pg/test-harness';
import { appendAudit, verifyChain, type ChainReport } from './index';
import {
  ORG_A,
  ORG_B,
  PLATFORM_ORG,
  asSuperuser,
  createTestDb,
  openFixture,
  orgCtx,
  withTriggersOff,
  type AuditFixture,
} from './audit-test-kit';

// MIL-82：verifyChain() 與 ADR-0019 的竄改實測情境。
// 竄改一律用 superuser 並關掉觸發器，模擬資料庫被入侵。ADR-0019 實測結果的最後三列在這裡。

describe('verifyChain()', () => {
  let testDb: TestDb;
  let f: AuditFixture;
  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    f = await openFixture(testDb);
  });
  afterEach(() => f.close());

  const seed = async (orgId = ORG_A, n = 4) => {
    for (let i = 1; i <= n; i++) {
      await f.withTx(orgCtx(orgId), (tx) =>
        appendAudit(tx, { action: 'ledger.entry', object: { type: 'ledger', id: `L-${i}` }, payload: { amount: i * 100 } }),
      );
    }
  };
  const verify = (orgId = ORG_A): Promise<ChainReport> => f.withTx(orgCtx(orgId), (tx) => verifyChain(tx));
  const kinds = (r: ChainReport) => r.issues.map((i) => `${i.kind}@${i.seq}`);
  const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

  describe('沒被動過的鏈', () => {
    it('空鏈通過，筆數 0，headHash 是 64 個 0', async () => {
      expect(await verify()).toEqual({ ok: true, chainId: ORG_A, count: 0, headHash: '0'.repeat(64), issues: [] });
    });

    it('寫了幾筆就驗到幾筆，headHash 是最後一筆的 hash', async () => {
      await seed(ORG_A, 4);
      const last = await f.withTx(orgCtx(ORG_A), (tx) => appendAudit(tx, { action: 'member.grant' }));
      const report = await verify();
      expect(report).toMatchObject({ ok: true, chainId: ORG_A, count: 5, issues: [] });
      expect(report.headHash).toBe(last.hash);
    });

    it('超過 10 筆時按數字排序驗證（序號 10 排在 9 後面，不是 1 後面）', async () => {
      await seed(ORG_A, 12);
      expect(await verify()).toMatchObject({ ok: true, count: 12, issues: [] });
    });

    it('只驗自己的鏈：B 的事件被動過不影響 A', async () => {
      await seed(ORG_A);
      await seed(ORG_B);
      await withTriggersOff(f.db, () => f.db.query(`UPDATE audit.events SET action = 'member.grant' WHERE chain_id = $1`, [ORG_B]));
      expect((await verify(ORG_A)).ok).toBe(true);
      expect((await verify(ORG_B)).ok).toBe(false);
    });

    it('平台組織的鏈用平台組織的 ID 驗證', async () => {
      await f.withTx({ kind: 'control' }, (tx) => appendAudit(tx, { action: 'tenant.login' }));
      expect(await verify(PLATFORM_ORG)).toMatchObject({ ok: true, count: 1 });
    });

    it('session 時區不同，驗證結果相同', async () => {
      await f.db.exec(`SET TIME ZONE 'America/Los_Angeles'`);
      await seed(ORG_A, 3);
      await f.db.exec(`SET TIME ZONE 'Asia/Taipei'`);
      expect((await verify()).ok).toBe(true);
      await f.db.exec(`SET TIME ZONE 'UTC'`);
      expect((await verify()).ok).toBe(true);
    });

    it('沒有組織脈絡時拒絕驗證，不會對 0 筆事件回報通過', async () => {
      await expect(f.withTx({ kind: 'control' }, (tx) => verifyChain(tx as never))).rejects.toThrow(/組織脈絡/);
    });
  });

  describe('竄改（AC8、ADR-0019 實測情境）', () => {
    it('超級使用者關閉觸發器、只改欄位：欄位與 canonical 不符', async () => {
      await seed();
      await withTriggersOff(f.db, () =>
        f.db.query(`UPDATE audit.events SET action = 'member.revoke', actor_id = 'someone' WHERE chain_id = $1 AND seq = 2`, [ORG_A]),
      );
      const report = await verify();
      expect(report.ok).toBe(false);
      expect(kinds(report)).toEqual(['canonical_mismatch@2']);
      expect(report.issues[0].detail).toContain('action');
      expect(report.issues[0].detail).toContain('actor.id');
    });

    it('只改 payload 欄位也抓得到', async () => {
      await seed();
      await withTriggersOff(f.db, () =>
        f.db.query(`UPDATE audit.events SET payload = '{"amount": 999999}' WHERE chain_id = $1 AND seq = 3`, [ORG_A]),
      );
      const report = await verify();
      expect(kinds(report)).toEqual(['canonical_mismatch@3']);
      expect(report.issues[0].detail).toContain('payload');
    });

    it('只改 occurred_at 欄位也抓得到', async () => {
      await seed();
      await withTriggersOff(f.db, () =>
        f.db.query(`UPDATE audit.events SET occurred_at = occurred_at + interval '1 hour' WHERE chain_id = $1 AND seq = 1`, [ORG_A]),
      );
      const report = await verify();
      expect(kinds(report)).toEqual(['canonical_mismatch@1']);
      expect(report.issues[0].detail).toContain('at');
    });

    it('超級使用者改 canonical、不重算 hash：斷鏈', async () => {
      await seed();
      await withTriggersOff(f.db, () =>
        f.db.query(`UPDATE audit.events SET canonical = replace(canonical, 'ledger.entry', 'member.grant') WHERE chain_id = $1 AND seq = 2`, [ORG_A]),
      );
      const report = await verify();
      expect(report.ok).toBe(false);
      expect(kinds(report)).toContain('hash_mismatch@2');
    });

    it('canonical 與欄位一起改、不重算 hash：仍然斷鏈', async () => {
      await seed();
      await withTriggersOff(f.db, () =>
        f.db.query(
          `UPDATE audit.events SET action = 'member.grant', canonical = replace(canonical, 'ledger.entry', 'member.grant')
            WHERE chain_id = $1 AND seq = 2`,
          [ORG_A],
        ),
      );
      expect(kinds(await verify())).toEqual(['hash_mismatch@2']);
    });

    it('改 prev_hash 與 hash 讓單筆自洽：與上一筆接不上', async () => {
      await seed();
      const rows = await f.withTx(orgCtx(ORG_A), async (tx) => (await tx.query<{ canonical: string }>(`SELECT canonical FROM audit.events WHERE seq = 3`)).rows);
      const fakePrev = 'a'.repeat(64);
      await withTriggersOff(f.db, () =>
        f.db.query(`UPDATE audit.events SET prev_hash = $1, hash = $2 WHERE chain_id = $3 AND seq = 3`, [fakePrev, sha(fakePrev + rows[0].canonical), ORG_A]),
      );
      const report = await verify();
      expect(kinds(report)).toContain('prev_hash_mismatch@3');
      expect(kinds(report)).toContain('prev_hash_mismatch@4'); // 下一筆接的是原本的 hash，現在對不上
    });

    it('刪掉中間的事件：序號不連續', async () => {
      await seed();
      await withTriggersOff(f.db, () => f.db.query(`DELETE FROM audit.events WHERE chain_id = $1 AND seq = 2`, [ORG_A]));
      const report = await verify();
      expect(kinds(report)).toContain('seq_gap@3');
      expect(kinds(report)).toContain('prev_hash_mismatch@3');
    });

    it('刪掉尾端的事件：鏈頭與事件表不符', async () => {
      await seed();
      await withTriggersOff(f.db, () => f.db.query(`DELETE FROM audit.events WHERE chain_id = $1 AND seq = 4`, [ORG_A]));
      const report = await verify();
      expect(kinds(report)).toEqual(['head_mismatch@null']);
    });

    it('第一筆被刪：序號不是從 1 開始', async () => {
      await seed();
      await withTriggersOff(f.db, () => f.db.query(`DELETE FROM audit.events WHERE chain_id = $1 AND seq = 1`, [ORG_A]));
      expect(kinds(await verify())).toContain('seq_gap@2');
    });

    it('canonical 不是合法 JSON', async () => {
      await seed();
      await withTriggersOff(f.db, async () => {
        const { rows } = await f.db.query<{ prev_hash: string }>(`SELECT prev_hash FROM audit.events WHERE chain_id = $1 AND seq = 4`, [ORG_A]);
        // 連 hash 一起重算，只剩 canonical 本身不合法
        await f.db.query(`UPDATE audit.events SET canonical = 'not json', hash = $1 WHERE chain_id = $2 AND seq = 4`, [sha(rows[0].prev_hash + 'not json'), ORG_A]);
        await f.db.query(`UPDATE audit.chain_heads SET head_hash = $1 WHERE chain_id = $2`, [sha(rows[0].prev_hash + 'not json'), ORG_A]);
      });
      expect(kinds(await verify())).toEqual(['canonical_invalid@4']);
    });

    it('動作不在 AUDIT_ACTIONS 清單內：回報 unknown_action', async () => {
      await f.withTx(orgCtx(ORG_A), (tx) => tx.query(`SELECT audit.append('made_up.action')`)); // 繞過 TypeScript 入口
      const report = await verify();
      expect(kinds(report)).toEqual(['unknown_action@1']);
    });

    it('從頭到尾重算整條鏈與鏈頭：本地驗證通過，鏈頭與舊值不同（只有外部回執抓得到，MIL-88）', async () => {
      await seed();
      const before = await verify();

      await withTriggersOff(f.db, async () => {
        const { rows } = await f.db.query<{ seq: string; canonical: string }>(
          `SELECT seq, canonical FROM audit.events WHERE chain_id = $1 ORDER BY seq`,
          [ORG_A],
        );
        let prev = '0'.repeat(64);
        for (const row of rows) {
          // 竄改第 2 筆：欄位與 canonical 同步改，之後每一筆重算
          const canonical = Number(row.seq) === 2 ? row.canonical.replace('ledger.entry', 'member.grant') : row.canonical;
          const hash = sha(prev + canonical);
          await f.db.query(
            `UPDATE audit.events SET canonical = $1, prev_hash = $2, hash = $3,
                    action = CASE WHEN seq = 2 THEN 'member.grant' ELSE action END
              WHERE chain_id = $4 AND seq = $5`,
            [canonical, prev, hash, ORG_A, Number(row.seq)],
          );
          prev = hash;
        }
        await f.db.query(`UPDATE audit.chain_heads SET head_hash = $1 WHERE chain_id = $2`, [prev, ORG_A]);
      });

      const after = await verify();
      expect(after.ok).toBe(true);
      expect(after.headHash).not.toBe(before.headHash);
    });

    it('改鏈頭但不動事件：head_mismatch', async () => {
      await seed();
      await asSuperuser(f.db, () => f.db.query(`UPDATE audit.chain_heads SET head_hash = $1 WHERE chain_id = $2`, ['b'.repeat(64), ORG_A]));
      expect(kinds(await verify())).toEqual(['head_mismatch@null']);
    });

    it('有事件但鏈頭不見：head_mismatch', async () => {
      await seed(ORG_A, 2);
      await withTriggersOff(f.db, async () => {
        await f.db.exec('ALTER TABLE audit.chain_heads DISABLE TRIGGER USER');
        await f.db.query(`DELETE FROM audit.chain_heads WHERE chain_id = $1`, [ORG_A]);
        await f.db.exec('ALTER TABLE audit.chain_heads ENABLE TRIGGER USER');
      });
      expect(kinds(await verify())).toEqual(['head_mismatch@null']);
    });
  });
});
