import { describe, expect, it } from 'vitest';
import type { SqlExecutor, TxDriver } from './executor';
import {
  buildBeginSql,
  createWithTx,
  type ControlTx,
  type DbContext,
  type OrgTx,
  type PartyTx,
  type Tx,
} from './with-tx';

// 不需要資料庫的部分：往返次數、連線釋放、型別防護。資料庫行為在 with-tx-contract.ts。

const ORG = '01JBKQ0000000000000000000A';
const PARTY = '01JBKQ0000000000000000000P';
const OPERATOR = '01JBKQ0000000000000000000X';

/** 記錄每次往返的假驅動。 */
function recordingDriver(options: { failOn?: RegExp; failRollback?: boolean } = {}) {
  const calls: string[] = [];
  const released: boolean[] = [];
  let acquired = 0;
  const conn: SqlExecutor = {
    exec: async (sql) => {
      calls.push(sql);
      if (options.failRollback && sql === 'ROLLBACK') throw new Error('connection lost');
      if (options.failOn?.test(sql)) throw new Error(`exec 失敗：${sql}`);
    },
    query: async (sql) => {
      calls.push(sql);
      return { rows: [] };
    },
  };
  const driver: TxDriver = {
    acquire: async () => {
      acquired++;
      return { conn, release: (broken) => void released.push(broken) };
    },
    close: async () => undefined,
  };
  return { driver, calls, released, acquired: () => acquired };
}

describe('往返次數', () => {
  it('BEGIN、逾時與 set_config 在同一次 exec 送出，callback 之前只有一次往返', async () => {
    const { driver, calls } = recordingDriver();
    await createWithTx(driver)({ kind: 'org', orgId: ORG, partyId: PARTY }, async (tx) => {
      await tx.query('SELECT 1');
    });
    expect(calls).toHaveLength(3); // 開始、callback 的 query、COMMIT
    expect(calls[0]).toMatch(/^BEGIN;/);
    expect(calls[0]).toContain(`set_config('app.org_id', '${ORG}', true)`);
    expect(calls[0]).toContain(`set_config('app.party_id', '${PARTY}', true)`);
    expect(calls[0]).toContain('SET LOCAL statement_timeout = 15000');
    expect(calls[0]).toContain('SET LOCAL idle_in_transaction_session_timeout = 10000');
    expect(calls[2]).toBe('COMMIT');
  });

  it('control 脈絡沒有 set_config，但仍設逾時', () => {
    const sql = buildBeginSql({ kind: 'control' });
    expect(sql).not.toContain('set_config');
    expect(sql).toContain('statement_timeout');
  });

  it('只用交易範圍的 set_config，不出現 session 層級的 SET', () => {
    for (const ctx of [
      { kind: 'org', orgId: ORG },
      { kind: 'party', partyId: PARTY },
      { kind: 'operator', operatorId: OPERATOR, orgId: ORG, ticketId: 'T-1' },
    ] satisfies DbContext[]) {
      const sql = buildBeginSql(ctx);
      expect(sql.match(/set_config\([^)]*\)/g)!.every((c) => c.endsWith(', true)'))).toBe(true);
      expect(sql.match(/\bSET\b(?! LOCAL)/g)).toBeNull();
    }
  });
});

describe('連線的釋放', () => {
  it('成功時釋放為正常連線', async () => {
    const { driver, released } = recordingDriver();
    await createWithTx(driver)({ kind: 'control' }, async () => 1);
    expect(released).toEqual([false]);
  });

  it('callback 失敗時送 ROLLBACK，連線仍視為正常', async () => {
    const { driver, calls, released } = recordingDriver();
    await expect(
      createWithTx(driver)({ kind: 'control' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(released).toEqual([false]);
  });

  it('ROLLBACK 也失敗時，連線標記為壞的，原本的錯誤仍是丟出的那個', async () => {
    const { driver, released } = recordingDriver({ failRollback: true });
    await expect(
      createWithTx(driver)({ kind: 'control' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(released).toEqual([true]);
  });

  it('COMMIT 失敗時回滾並丟出 COMMIT 的錯誤', async () => {
    const { driver, calls } = recordingDriver({ failOn: /^COMMIT$/ });
    await expect(createWithTx(driver)({ kind: 'control' }, async () => 1)).rejects.toThrow(/COMMIT/);
    expect(calls.at(-1)).toBe('ROLLBACK');
  });

  it('格式錯誤的脈絡在借連線之前就被拒絕', async () => {
    const { driver, acquired } = recordingDriver();
    await expect(createWithTx(driver)({ kind: 'org', orgId: 'bad' }, async () => 1)).rejects.toThrow(/orgId/);
    expect(acquired()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 型別防護：下面的檔案內容由 tsc 檢查。@ts-expect-error 沒有錯可擋時，tsc 會報「未使用的指令」

function claimTask(tx: ControlTx): Promise<unknown> {
  return tx.query('SELECT 1');
}
function listObjects(tx: OrgTx): Promise<unknown> {
  return tx.query('SELECT 1');
}
function readAsTenant(tx: PartyTx): Promise<unknown> {
  return tx.query('SELECT 1');
}

describe('型別防護（由 tsc 驗證）', () => {
  // 這些呼叫都不會執行，只要 tsc 通過就代表型別行為正確
  const never = async () => {
    const withTx = createWithTx(recordingDriver().driver);

    await withTx({ kind: 'control' }, (tx) => claimTask(tx));
    await withTx({ kind: 'org', orgId: ORG }, (tx) => listObjects(tx));
    await withTx({ kind: 'operator', operatorId: OPERATOR, orgId: ORG, ticketId: 'T-1' }, (tx) => listObjects(tx));
    await withTx({ kind: 'party', partyId: PARTY }, (tx) => readAsTenant(tx));

    // 組織範圍的 tx 傳給 control 的方法
    // @ts-expect-error org 的 tx 不是 ControlTx
    await withTx({ kind: 'org', orgId: ORG }, (tx) => claimTask(tx));
    // @ts-expect-error operator 的 tx 不是 ControlTx
    await withTx({ kind: 'operator', operatorId: OPERATOR, orgId: ORG, ticketId: 'T-1' }, (tx) => claimTask(tx));
    // control 的 tx 傳給組織範圍的方法
    // @ts-expect-error control 的 tx 不是 OrgTx
    await withTx({ kind: 'control' }, (tx) => listObjects(tx));
    // @ts-expect-error party 的 tx 不是 OrgTx
    await withTx({ kind: 'party', partyId: PARTY }, (tx) => listObjects(tx));
    // @ts-expect-error org 的 tx 不是 PartyTx
    await withTx({ kind: 'org', orgId: ORG }, (tx) => readAsTenant(tx));

    // 脈絡缺必填欄位
    // @ts-expect-error operator 脈絡必須有 ticketId
    await withTx({ kind: 'operator', operatorId: OPERATOR, orgId: ORG }, async () => 1);
    // @ts-expect-error org 脈絡必須有 orgId
    await withTx({ kind: 'org' }, async () => 1);

    // 型別不確定的脈絡（union）產生的 tx，哪一種方法都不能傳
    const unknownCtx = { kind: 'control' } as DbContext;
    // @ts-expect-error union 的 tx 不得傳給 control 的方法
    await withTx(unknownCtx, (tx: Tx) => claimTask(tx));
  };

  it('編譯通過即為通過', () => {
    expect(typeof never).toBe('function');
  });
});
