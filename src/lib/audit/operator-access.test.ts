import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor, TxDriver } from '../pg/executor';
import type { TestDb } from '../pg/test-harness';
import { createWithTx, type DbContext } from '../pg/with-tx';
import { appendAudit, verifyChain } from './index';
import { ORG_A, ORG_B, OPERATOR_X, PLATFORM_ORG, createTestDb, openFixture, orgCtx, type AuditFixture } from './audit-test-kit';

// MIL-82：operator 脈絡的 withTx 在同交易寫存取紀錄（P0-23 AC5）。
// hook 接在 MIL-80 的 withTx 上，不改它的介面形狀：withTx(ctx, fn) 照舊。

const operator = (ticketId: string, orgId = ORG_A): DbContext => ({ kind: 'operator', operatorId: OPERATOR_X, orgId, ticketId });

interface AccessRow {
  chain_id: string;
  seq: string;
  action: string;
  actor_type: string;
  actor_id: string;
  object_type: string;
  object_id: string;
  payload: { ticket: string };
}

describe('operator 脈絡的存取紀錄', () => {
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

  const eventsOf = (orgId: string) =>
    f.withTx(orgCtx(orgId), async (tx) => (await tx.query<AccessRow>('SELECT * FROM audit.events ORDER BY seq')).rows);

  it('進入組織就寫一筆存取紀錄：含工單號、營運者，鏈是目標組織', async () => {
    await f.withTx(operator('CASE-1001'), async () => undefined);
    const rows = await eventsOf(ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      chain_id: ORG_A,
      action: 'operator.access',
      actor_type: 'operator',
      actor_id: OPERATOR_X,
      object_type: 'org',
      object_id: ORG_A,
    });
    expect(rows[0].payload).toEqual({ ticket: 'CASE-1001' });
    expect(JSON.parse((rows[0] as unknown as { canonical: string }).canonical).payload).toEqual({ ticket: 'CASE-1001' });
  });

  it('不寫到平台鏈，也不寫到其他組織的鏈', async () => {
    await f.withTx(operator('CASE-1001'), async () => undefined);
    expect(await eventsOf(PLATFORM_ORG)).toEqual([]);
    expect(await eventsOf(ORG_B)).toEqual([]);
  });

  it('A 組織的管理員匯出自己的鏈看得到營運者的存取，B 看不到（P0-23 AC6）', async () => {
    await f.withTx(operator('CASE-1001', ORG_A), async () => undefined);
    await f.withTx(operator('CASE-2002', ORG_B), async () => undefined);
    expect((await eventsOf(ORG_A)).map((r) => r.payload.ticket)).toEqual(['CASE-1001']);
    expect((await eventsOf(ORG_B)).map((r) => r.payload.ticket)).toEqual(['CASE-2002']);
  });

  it('紀錄與 callback 同一個交易：callback 內讀得到剛寫的紀錄', async () => {
    const seen = await f.withTx(operator('CASE-1001'), async (tx) => {
      const { rows } = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM audit.events`);
      return Number(rows[0].n);
    });
    expect(seen).toBe(1);
  });

  it('callback 拋例外時交易回滾，紀錄一併消失，序號不推進', async () => {
    await expect(
      f.withTx(operator('CASE-1001'), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await eventsOf(ORG_A)).toEqual([]);
    await f.withTx(operator('CASE-1002'), async () => undefined);
    expect((await eventsOf(ORG_A)).map((r) => Number(r.seq))).toEqual([1]);
  });

  it('每次進入各寫一筆，序號接續一般事件', async () => {
    await f.withTx(orgCtx(ORG_A), (tx) => appendAudit(tx, { action: 'member.grant' }));
    await f.withTx(operator('CASE-1001'), async () => undefined);
    await f.withTx(operator('CASE-1001'), async () => undefined);
    expect((await eventsOf(ORG_A)).map((r) => [Number(r.seq), r.action])).toEqual([
      [1, 'member.grant'],
      [2, 'operator.access'],
      [3, 'operator.access'],
    ]);
  });

  it('operator 脈絡內再寫的事件，行為者也是營運者', async () => {
    await f.withTx(operator('CASE-1001'), (tx) => appendAudit(tx, { action: 'rental_right.judge' }));
    const rows = await eventsOf(ORG_A);
    expect(rows.map((r) => [r.action, r.actor_type, r.actor_id])).toEqual([
      ['operator.access', 'operator', OPERATOR_X],
      ['rental_right.judge', 'operator', OPERATOR_X],
    ]);
  });

  it('工單號為空或含特殊字元時被拒絕，不寫任何紀錄', async () => {
    await expect(f.withTx(operator(''), async () => 1)).rejects.toThrow(/工單號/);
    await expect(f.withTx(operator("x'; --"), async () => 1)).rejects.toThrow(/工單號/);
    expect(await eventsOf(ORG_A)).toEqual([]);
  });

  it('寫出來的鏈驗證通過', async () => {
    await f.withTx(operator('CASE-1001'), async () => undefined);
    await f.withTx(operator('CASE-1002'), async () => undefined);
    expect(await f.withTx(orgCtx(ORG_A), (tx) => verifyChain(tx))).toMatchObject({ ok: true, count: 2 });
  });

  it('org 脈絡直接呼叫 record_operator_access() 被拒絕：缺營運者與工單號', async () => {
    await expect(f.withTx(orgCtx(ORG_A), (tx) => tx.query('SELECT audit.record_operator_access()'))).rejects.toThrow(
      /app\.operator_id/,
    );
  });
});

// 不需要資料庫的部分：hook 的位置與失敗行為
describe('hook 的位置', () => {
  function recordingDriver(options: { failOn?: RegExp } = {}) {
    const calls: string[] = [];
    const conn: SqlExecutor = {
      exec: async (sql) => void calls.push(sql),
      query: async (sql) => {
        calls.push(sql);
        if (options.failOn?.test(sql)) throw new Error('紀錄寫不進去');
        return { rows: [] };
      },
    };
    const driver: TxDriver = { acquire: async () => ({ conn, release: () => undefined }), close: async () => undefined };
    return { driver, calls };
  }

  it('operator：BEGIN 之後、callback 之前寫紀錄，順序是 BEGIN、紀錄、callback、COMMIT', async () => {
    const { driver, calls } = recordingDriver();
    await createWithTx(driver)(operator('T-1'), async (tx) => {
      await tx.query('SELECT 42');
    });
    expect(calls[0]).toMatch(/^BEGIN;/);
    expect(calls[1]).toBe('SELECT * FROM audit.record_operator_access()');
    expect(calls[2]).toBe('SELECT 42');
    expect(calls[3]).toBe('COMMIT');
  });

  it.each<DbContext>([{ kind: 'org', orgId: ORG_A }, { kind: 'party', partyId: OPERATOR_X }, { kind: 'control' }])(
    '%j 脈絡不寫存取紀錄',
    async (ctx) => {
      const { driver, calls } = recordingDriver();
      await createWithTx(driver)(ctx, async () => undefined);
      expect(calls.some((c) => c.includes('record_operator_access'))).toBe(false);
    },
  );

  it('紀錄寫不進去時交易回滾，callback 不會執行（沒有紀錄就沒有存取）', async () => {
    const { driver, calls } = recordingDriver({ failOn: /record_operator_access/ });
    let ran = false;
    await expect(
      createWithTx(driver)(operator('T-1'), async () => {
        ran = true;
      }),
    ).rejects.toThrow('紀錄寫不進去');
    expect(ran).toBe(false);
    expect(calls.at(-1)).toBe('ROLLBACK');
  });

  it('withTx 的介面形狀不變：仍是 (ctx, fn)，選項的 afterBegin 可以換掉預設 hook', async () => {
    const { driver, calls } = recordingDriver();
    const seen: string[] = [];
    await createWithTx(driver, { afterBegin: async (ctx) => void seen.push(ctx.kind) })(operator('T-1'), async () => undefined);
    expect(seen).toEqual(['operator']);
    expect(calls.some((c) => c.includes('record_operator_access'))).toBe(false);
  });
});
