import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asRole, type TestDb } from '../pg/test-harness';
import { appendAudit, AUDIT_ACTIONS, isAuditAction, type AuditAction } from './index';
import {
  ORG_A,
  ORG_B,
  PARTY_P,
  PLATFORM_ORG,
  createTestDb,
  openFixture,
  orgCtx,
  type AuditFixture,
} from './audit-test-kit';

// MIL-82：audit.append() 與事件表。seam 有兩個：appendAudit（TypeScript 入口）與 app_rw 對 audit schema 的直接存取。
// 每個測試的連線身分都是 app_rw（harness 的 fresh()），所以 RLS 與權限的結果是真的。

interface EventRow {
  chain_id: string;
  seq: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
  prev_hash: string;
  hash: string;
  canonical: string;
  occurred_at: Date;
}

describe('audit.append()', () => {
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

  const readEvents = (ctx: Parameters<typeof f.withTx>[0]) =>
    f.withTx(ctx, async (tx) => (await tx.query<EventRow>('SELECT * FROM audit.events ORDER BY seq')).rows);

  describe('鏈由 app.org_id 決定（AC1）', () => {
    it('組織成員的操作寫在該組織的鏈，序號各自遞增', async () => {
      const a1 = await f.withTx(orgCtx(ORG_A), (tx) => appendAudit(tx, { action: 'member.grant' }));
      const b1 = await f.withTx(orgCtx(ORG_B), (tx) => appendAudit(tx, { action: 'member.grant' }));
      const a2 = await f.withTx(orgCtx(ORG_A), (tx) => appendAudit(tx, { action: 'member.revoke' }));
      expect([a1.chainId, a1.seq]).toEqual([ORG_A, 1]);
      expect([b1.chainId, b1.seq]).toEqual([ORG_B, 1]);
      expect([a2.chainId, a2.seq]).toEqual([ORG_A, 2]);
    });

    it('沒有組織脈絡（control、party）時寫平台組織的鏈', async () => {
      const viaControl = await f.withTx({ kind: 'control' }, (tx) => appendAudit(tx, { action: 'tenant.login' }));
      const viaParty = await f.withTx({ kind: 'party', partyId: PARTY_P }, (tx) => appendAudit(tx, { action: 'tenant.login' }));
      expect(viaControl.chainId).toBe(PLATFORM_ORG);
      expect(viaParty).toMatchObject({ chainId: PLATFORM_ORG, seq: 2 });
    });

    it('app.org_id 是空字串時也寫平台組織的鏈', async () => {
      const ref = await f.withTx({ kind: 'control' }, async (tx) => {
        await tx.query(`SELECT set_config('app.org_id', '', true)`);
        return appendAudit(tx, { action: 'tenant.login' });
      });
      expect(ref.chainId).toBe(PLATFORM_ORG);
    });

    it('呼叫端無法指定鏈：appendAudit 的輸入沒有鏈的欄位，audit.append() 的參數也沒有', async () => {
      const { rows } = await f.db.query<{ args: string }>(
        `SELECT pg_get_function_arguments(p.oid) AS args FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'audit' AND p.proname = 'append'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].args).not.toMatch(/chain|org/i);
    });

    it('app.org_id 不是合法 ULID 時拒絕寫入', async () => {
      await expect(
        f.withTx({ kind: 'control' }, async (tx) => {
          await tx.query(`SELECT set_config('app.org_id', 'not-a-ulid', true)`);
          return appendAudit(tx, { action: 'tenant.login' });
        }),
      ).rejects.toThrow(/chain_id/);
    });
  });

  describe('交易回滾（AC2）', () => {
    it('回滾的交易不推進序號，下一筆接續沒有跳號', async () => {
      await f.withTx(orgCtx(ORG_A), (tx) => appendAudit(tx, { action: 'member.grant' }));
      await expect(
        f.withTx(orgCtx(ORG_A), async (tx) => {
          const ref = await appendAudit(tx, { action: 'member.grant' });
          expect(ref.seq).toBe(2);
          throw new Error('業務失敗');
        }),
      ).rejects.toThrow('業務失敗');
      const next = await f.withTx(orgCtx(ORG_A), (tx) => appendAudit(tx, { action: 'member.revoke' }));
      expect(next.seq).toBe(2);
      expect((await readEvents(orgCtx(ORG_A))).map((r) => Number(r.seq))).toEqual([1, 2]);
    });

    it('第一筆就回滾：鏈頭也跟著回滾，之後仍從 1 開始', async () => {
      await expect(
        f.withTx(orgCtx(ORG_B), async (tx) => {
          await appendAudit(tx, { action: 'member.grant' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const ref = await f.withTx(orgCtx(ORG_B), (tx) => appendAudit(tx, { action: 'member.grant' }));
      expect(ref.seq).toBe(1);
    });

    it('同一個交易寫多筆，序號連續', async () => {
      const seqs = await f.withTx(orgCtx(ORG_A), async (tx) => [
        (await appendAudit(tx, { action: 'ledger.entry' })).seq,
        (await appendAudit(tx, { action: 'ledger.entry' })).seq,
        (await appendAudit(tx, { action: 'ledger.entry' })).seq,
      ]);
      expect(seqs).toEqual([1, 2, 3]);
    });
  });

  describe('雜湊格式（AC3，ADR-0019 決議 4）', () => {
    it('第一筆的 prev_hash 是 64 個 0，之後每筆的 hash = sha256(prev_hash || canonical)，Node 獨立重算一致', async () => {
      for (const action of ['member.grant', 'member.revoke', 'ledger.entry'] as const) {
        await f.withTx(orgCtx(ORG_A), (tx) => appendAudit(tx, { action, payload: { n: 1 } }));
      }
      const rows = await readEvents(orgCtx(ORG_A));
      expect(rows[0].prev_hash).toBe('0'.repeat(64));
      for (const [i, row] of rows.entries()) {
        if (i > 0) expect(row.prev_hash).toBe(rows[i - 1].hash);
        const expected = createHash('sha256').update(row.prev_hash + row.canonical, 'utf8').digest('hex');
        expect(row.hash).toBe(expected);
        expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('canonical 是文字，內含 v、鏈、序號、時間、行為者、動作、物件與 payload', async () => {
      await f.withTx({ kind: 'org', orgId: ORG_A, partyId: PARTY_P }, (tx) =>
        appendAudit(tx, { action: 'deposit.confirm', object: { type: 'ledger', id: 'L-1' }, payload: { amount: 5000 } }),
      );
      const [row] = await readEvents(orgCtx(ORG_A));
      expect(typeof row.canonical).toBe('string');
      const c = JSON.parse(row.canonical);
      expect(c).toMatchObject({
        v: 1,
        chain: ORG_A,
        seq: 1,
        actor: { type: 'party', id: PARTY_P },
        action: 'deposit.confirm',
        object: { type: 'ledger', id: 'L-1' },
        payload: { amount: 5000 },
      });
      expect(c.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    });

    it('session 時區不影響 canonical 的時間：UTC 與 Asia/Taipei 寫出的格式相同，且都等於 occurred_at', async () => {
      for (const zone of ['UTC', 'Asia/Taipei', 'America/Los_Angeles']) {
        await f.db.exec(`SET TIME ZONE '${zone}'`);
        await f.withTx(orgCtx(ORG_A), (tx) => appendAudit(tx, { action: 'ledger.entry' }));
      }
      const rows = await readEvents(orgCtx(ORG_A));
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        const at = JSON.parse(row.canonical).at as string;
        expect(at).toMatch(/Z$/);
        expect(new Date(at).getTime()).toBe(row.occurred_at.getTime());
      }
      // 對照組：資料庫自己的 timestamptz 文字會隨 session 時區變，這就是不能在驗證時重新序列化的原因
      await f.db.exec(`SET TIME ZONE 'UTC'`);
      const utc = (await f.db.query<{ t: string }>(`SELECT now()::text AS t`)).rows[0].t;
      await f.db.exec(`SET TIME ZONE 'Asia/Taipei'`);
      const taipei = (await f.db.query<{ t: string }>(`SELECT now()::text AS t`)).rows[0].t;
      expect(utc.slice(-3)).not.toBe(taipei.slice(-3));
    });

    it('同一條鏈上的時間不會倒退', async () => {
      for (let i = 0; i < 5; i++) await f.withTx(orgCtx(ORG_A), (tx) => appendAudit(tx, { action: 'ledger.entry' }));
      const rows = await readEvents(orgCtx(ORG_A));
      const times = rows.map((r) => r.occurred_at.getTime());
      expect(times).toEqual([...times].sort((x, y) => x - y));
    });
  });

  describe('行為者從脈絡取', () => {
    it.each([
      ['org 脈絡沒有 partyId', { kind: 'org', orgId: ORG_A }, 'system', null],
      ['org 脈絡帶 partyId', { kind: 'org', orgId: ORG_A, partyId: PARTY_P }, 'party', PARTY_P],
    ] as const)('%s', async (_name, ctx, type, id) => {
      await f.withTx(ctx, (tx) => appendAudit(tx, { action: 'member.grant' }));
      const [row] = await readEvents(orgCtx(ORG_A));
      expect([row.actor_type, row.actor_id]).toEqual([type, id]);
    });

    it('登入前的動作可以明確指定行為者', async () => {
      await f.withTx({ kind: 'control' }, (tx) =>
        appendAudit(tx, { action: 'tenant.login', actor: { type: 'party', id: PARTY_P } }),
      );
      const rows = await readEvents(orgCtx(PLATFORM_ORG));
      expect([rows[0].actor_type, rows[0].actor_id]).toEqual(['party', PARTY_P]);
    });
  });

  describe('動作名稱是程式內的常數清單（AC9）', () => {
    it('清單外的動作被 appendAudit 拒絕，不會寫進資料庫', async () => {
      await expect(
        f.withTx(orgCtx(ORG_A), (tx) => appendAudit(tx, { action: 'made.up' as unknown as AuditAction })),
      ).rejects.toThrow(/AUDIT_ACTIONS/);
      expect(await readEvents(orgCtx(ORG_A))).toEqual([]);
    });

    it('清單的每一項都符合資料庫的格式限制，而且沒有重複', async () => {
      expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
      for (const action of AUDIT_ACTIONS) {
        expect(isAuditAction(action)).toBe(true);
        await f.withTx(orgCtx(ORG_A), (tx) => appendAudit(tx, { action }));
      }
      expect(await readEvents(orgCtx(ORG_A))).toHaveLength(AUDIT_ACTIONS.length);
    });

    it('資料庫端另有格式檢查：不合領域.動詞格式的名稱被 CHECK 擋下', async () => {
      await expect(
        f.withTx(orgCtx(ORG_A), (tx) => tx.query(`SELECT audit.append('NotAnAction')`)),
      ).rejects.toThrow(/events_action_check/);
    });

    it('payload 必須是 JSON 物件', async () => {
      await expect(
        f.withTx(orgCtx(ORG_A), (tx) => tx.query(`SELECT audit.append('ledger.entry', NULL, NULL, '[1]'::jsonb)`)),
      ).rejects.toThrow(/payload/);
    });
  });
});

describe('權限與 RLS', () => {
  let testDb: TestDb;
  let f: AuditFixture;
  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    f = await openFixture(testDb);
    // 先用函式寫好 A、B、平台各一筆
    await f.withTx(orgCtx(ORG_A), (tx) => appendAudit(tx, { action: 'member.grant' }));
    await f.withTx(orgCtx(ORG_B), (tx) => appendAudit(tx, { action: 'member.grant' }));
    await f.withTx({ kind: 'control' }, (tx) => appendAudit(tx, { action: 'tenant.login' }));
  });
  afterEach(() => f.close());

  const countFor = (ctx: Parameters<typeof f.withTx>[0]) =>
    f.withTx(ctx, async (tx) => Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM audit.events')).rows[0].n));

  describe('app_rw 直接寫入被拒（AC4）', () => {
    it('INSERT 事件表', async () => {
      await expect(
        f.db.query(
          `INSERT INTO audit.events (chain_id, seq, occurred_at, actor_type, action, payload, prev_hash, hash, canonical)
           VALUES ($1, 99, now(), 'system', 'member.grant', '{}', $2, $2, '{}')`,
          [ORG_A, '0'.repeat(64)],
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it.each([
      ['UPDATE', `UPDATE audit.events SET action = 'member.revoke'`],
      ['DELETE', `DELETE FROM audit.events`],
      ['TRUNCATE', `TRUNCATE audit.events`],
    ])('%s 事件表', async (_op, sql) => {
      await expect(f.db.query(sql)).rejects.toThrow(/permission denied/);
    });

    it.each(['SELECT * FROM audit.chain_heads', `UPDATE audit.chain_heads SET seq = 0`, `DELETE FROM audit.chain_heads`])(
      '鏈頭表完全沒有權限：%s',
      async (sql) => {
        await expect(f.db.query(sql)).rejects.toThrow(/permission denied/);
      },
    );

    it('不能呼叫內部函式 write_event，也不能呼叫 break-glass 的函式', async () => {
      await expect(
        f.db.query(`SELECT audit.write_event($1, 'system', NULL, 'member.grant', NULL, NULL, '{}')`, [ORG_A]),
      ).rejects.toThrow(/permission denied/);
      await expect(f.db.query(`SELECT audit.record_break_glass('start', 'INC-1', 'x')`)).rejects.toThrow(/permission denied/);
    });
  });

  describe('UPDATE、DELETE、TRUNCATE 被觸發器擋下，audit_owner 也一樣（AC5）', () => {
    it.each([
      ['UPDATE', `UPDATE audit.events SET action = 'member.revoke'`],
      ['DELETE', `DELETE FROM audit.events`],
      ['TRUNCATE', `TRUNCATE audit.events`],
      ['鏈頭 DELETE', `DELETE FROM audit.chain_heads`],
      ['鏈頭 TRUNCATE', `TRUNCATE audit.chain_heads`],
    ])('audit_owner 執行 %s', async (_op, sql) => {
      await expect(asRole(f.db, 'audit_owner', () => f.db.query(sql))).rejects.toThrow(/稽核紀錄只增不改/);
      // 事件完好
      expect(await countFor(orgCtx(ORG_A))).toBe(1);
    });

    it('擁有者的身分確實是 audit_owner，而且沒有 BYPASSRLS', async () => {
      const { rows } = await f.db.query<{ owner: string; bypass: boolean }>(
        `SELECT c.relowner::regrole::text AS owner, r.rolbypassrls AS bypass
           FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
          WHERE c.oid IN ('audit.events'::regclass, 'audit.chain_heads'::regclass)`,
      );
      expect(rows).toEqual([
        { owner: 'audit_owner', bypass: false },
        { owner: 'audit_owner', bypass: false },
      ]);
    });
  });

  describe('RLS（AC7、ADR-0019 決議 6）', () => {
    it('事件表與鏈頭表都 ENABLE 加 FORCE，audit_owner 有自己的政策', async () => {
      const { rows } = await f.db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE oid IN ('audit.events'::regclass, 'audit.chain_heads'::regclass) ORDER BY relname`,
      );
      expect(rows).toEqual([
        { relname: 'chain_heads', relrowsecurity: true, relforcerowsecurity: true },
        { relname: 'events', relrowsecurity: true, relforcerowsecurity: true },
      ]);
      const policies = await f.db.query<{ tablename: string; roles: string }>(
        `SELECT tablename, roles::text FROM pg_policies WHERE schemaname = 'audit' AND policyname = 'owner_all' ORDER BY tablename`,
      );
      expect(policies.rows).toEqual([
        { tablename: 'chain_heads', roles: '{audit_owner}' },
        { tablename: 'events', roles: '{audit_owner}' },
      ]);
    });

    it('A 組織脈絡只讀得到 A 的事件，B 同理', async () => {
      const a = await f.withTx(orgCtx(ORG_A), async (tx) => (await tx.query<{ chain_id: string }>('SELECT chain_id FROM audit.events')).rows);
      expect(a).toEqual([{ chain_id: ORG_A }]);
      const b = await f.withTx(orgCtx(ORG_B), async (tx) => (await tx.query<{ chain_id: string }>('SELECT chain_id FROM audit.events')).rows);
      expect(b).toEqual([{ chain_id: ORG_B }]);
    });

    it('沒有組織脈絡時讀到 0 筆，連平台鏈也看不到', async () => {
      expect(await countFor({ kind: 'control' })).toBe(0);
      expect(await countFor({ kind: 'party', partyId: PARTY_P })).toBe(0);
    });

    it('app.org_id 是空字串時讀到 0 筆', async () => {
      const n = await f.withTx({ kind: 'control' }, async (tx) => {
        await tx.query(`SELECT set_config('app.org_id', '', true)`);
        return Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM audit.events')).rows[0].n);
      });
      expect(n).toBe(0);
    });

    it('平台鏈要用平台組織的 ID 開 org 脈絡才讀得到', async () => {
      expect(await countFor(orgCtx(PLATFORM_ORG))).toBe(1);
    });
  });
});

describe('break-glass 使用紀錄（AC11 的資料庫部分）', () => {
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

  const asBreakGlass = <T>(fn: () => Promise<T>) => asRole(f.db, 'break_glass', fn);
  const eventsOf = (orgId: string) =>
    f.withTx(orgCtx(orgId), async (tx) => (await tx.query<EventRow & { payload: Record<string, unknown> }>('SELECT * FROM audit.events ORDER BY seq')).rows);

  it('break_glass 呼叫後寫一筆事件到平台鏈，行為者是資料庫登入身分，payload 有工單號與理由', async () => {
    await asBreakGlass(() => f.db.query(`SELECT audit.record_break_glass('start', 'INC-2026-11', '修復損毀的列')`));
    const rows = await eventsOf(PLATFORM_ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'break_glass.start', actor_type: 'break_glass', actor_id: 'postgres' });
    expect(rows[0].payload).toEqual({ ticket: 'INC-2026-11', reason: '修復損毀的列' });
  });

  it('指定組織時寫在該組織的鏈，組織匯出看得到', async () => {
    await asBreakGlass(() => f.db.query(`SELECT audit.record_break_glass('end', 'INC-1', '完成', $1)`, [ORG_A]));
    const rows = await eventsOf(ORG_A);
    expect(rows.map((r) => r.action)).toEqual(['break_glass.end']);
    expect(await eventsOf(PLATFORM_ORG)).toEqual([]);
  });

  it.each([
    ['階段不是 start 或 end', `SELECT audit.record_break_glass('middle', 'INC-1', 'x')`, /start 或 end/],
    ['沒有工單號', `SELECT audit.record_break_glass('start', '', 'x')`, /工單號/],
    ['工單號含特殊字元', `SELECT audit.record_break_glass('start', 'a;b', 'x')`, /工單號/],
    ['理由是空白', `SELECT audit.record_break_glass('start', 'INC-1', '   ')`, /理由/],
  ])('%s被拒絕', async (_name, sql, message) => {
    await expect(asBreakGlass(() => f.db.query(sql))).rejects.toThrow(message);
  });

  it('動作名稱在 AUDIT_ACTIONS 清單內', () => {
    expect(isAuditAction('break_glass.start')).toBe(true);
    expect(isAuditAction('break_glass.end')).toBe(true);
  });
});
