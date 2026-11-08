import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TxDriver } from './executor';
import { createWithTx, type DbContext } from './with-tx';

// withTx 的契約測試：pg 與 PGlite 兩個驅動 adapter 跑同一組（MIL-80）。
// 測試檔提供 harness，這裡只經 withTx 的介面操作與觀察，不看內部表。

export interface ContractHarness {
  /** 連線身分必須是 app_rw（PGlite 用 createTestDb().fresh()，pg 用 app_rw 登入）。 */
  driver: TxDriver;
  /** 以 app_owner 身分執行 DDL 或清表。 */
  asOwner(sql: string): Promise<void>;
  close(): Promise<void>;
}

export const ORG_A = '01JBKQ0000000000000000000A';
export const ORG_B = '01JBKQ0000000000000000000B';
export const PARTY_P = '01JBKQ0000000000000000000P';
export const OPERATOR_X = '01JBKQ0000000000000000000X';

// 一張掛 RLS 的組織表，政策照 ADR-0012 決議 1：current_setting 的缺省值要回傳 0 筆
const PROBE_DDL = `
  CREATE TABLE IF NOT EXISTS org.tx_probe (org_id text NOT NULL, note text NOT NULL);
  ALTER TABLE org.tx_probe ENABLE ROW LEVEL SECURITY;
  ALTER TABLE org.tx_probe FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS org_isolation ON org.tx_probe;
  CREATE POLICY org_isolation ON org.tx_probe
    USING (org_id = current_setting('app.org_id', true))
    WITH CHECK (org_id = current_setting('app.org_id', true));
`;

export function describeWithTxContract(label: string, setup: () => Promise<ContractHarness>) {
  describe(`withTx 契約：${label}`, () => {
    let h: ContractHarness;
    let withTx: ReturnType<typeof createWithTx>;

    beforeAll(async () => {
      h = await setup();
      await h.asOwner(PROBE_DDL);
      withTx = createWithTx(h.driver);
    });
    afterAll(() => h.close());
    beforeEach(() => h.asOwner('TRUNCATE org.tx_probe'));

    const orgCtx = (orgId: string): DbContext => ({ kind: 'org', orgId });
    const notes = (ctx: DbContext) =>
      withTx(ctx, async (tx) => (await tx.query<{ note: string }>('SELECT note FROM org.tx_probe ORDER BY note')).rows.map((r) => r.note));
    const insert = (orgId: string, note: string) =>
      withTx({ kind: 'org', orgId }, (tx) => tx.query('INSERT INTO org.tx_probe VALUES ($1, $2)', [orgId, note]));
    const setting = (ctx: DbContext, name: string) =>
      withTx(ctx, async (tx) => (await tx.query<{ v: string | null }>(`SELECT current_setting($1, true) AS v`, [name])).rows[0].v);

    // ADR-0012 Action Item 5：連線身分不是 app_rw 時，RLS 測試會全部假通過
    it('交易內的身分是 app_rw，不是 superuser，也沒有 BYPASSRLS', async () => {
      const who = await withTx({ kind: 'control' }, async (tx) =>
        (
          await tx.query(
            'SELECT current_user AS u, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user',
          )
        ).rows[0],
      );
      expect(who).toEqual({ u: 'app_rw', rolsuper: false, rolbypassrls: false });
    });

    describe('org 脈絡', () => {
      it('只看得到自己組織的列', async () => {
        await insert(ORG_A, 'a1');
        await insert(ORG_B, 'b1');
        expect(await notes(orgCtx(ORG_A))).toEqual(['a1']);
        expect(await notes(orgCtx(ORG_B))).toEqual(['b1']);
      });

      it('寫入別的組織的列被 RLS 擋下', async () => {
        await expect(
          withTx(orgCtx(ORG_A), (tx) => tx.query('INSERT INTO org.tx_probe VALUES ($1, $2)', [ORG_B, 'x'])),
        ).rejects.toThrow(/row-level security/);
      });

      it('帶 partyId 時兩個設定都在', async () => {
        const ctx: DbContext = { kind: 'org', orgId: ORG_A, partyId: PARTY_P };
        expect(await setting(ctx, 'app.org_id')).toBe(ORG_A);
        expect(await setting(ctx, 'app.party_id')).toBe(PARTY_P);
      });

      it('沒帶 partyId 時 app.party_id 是空的', async () => {
        expect(await setting(orgCtx(ORG_A), 'app.party_id')).toBeFalsy();
      });
    });

    describe('忘記設定組織脈絡（P0-02 AC2）', () => {
      it('control 脈絡查組織表回傳 0 筆，不丟錯', async () => {
        await insert(ORG_A, 'a1');
        expect(await notes({ kind: 'control' })).toEqual([]);
      });

      it('party 脈絡查組織表也是 0 筆', async () => {
        await insert(ORG_A, 'a1');
        expect(await notes({ kind: 'party', partyId: PARTY_P })).toEqual([]);
      });
    });

    describe('同一連線不留脈絡', () => {
      it('org 交易結束後，下一個 control 交易看不到組織與 party', async () => {
        await insert(ORG_A, 'a1');
        await setting({ kind: 'org', orgId: ORG_A, partyId: PARTY_P }, 'app.org_id');
        expect(await setting({ kind: 'control' }, 'app.org_id')).toBeFalsy();
        expect(await setting({ kind: 'control' }, 'app.party_id')).toBeFalsy();
        expect(await notes({ kind: 'control' })).toEqual([]);
      });

      it('交易失敗回滾後，脈絡也不留', async () => {
        await expect(
          withTx(orgCtx(ORG_A), async () => {
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        expect(await setting({ kind: 'control' }, 'app.org_id')).toBeFalsy();
      });

      it('連續交到不同組織，各自只看到自己的', async () => {
        await insert(ORG_A, 'a1');
        await insert(ORG_B, 'b1');
        for (let i = 0; i < 4; i++) {
          expect(await notes(orgCtx(i % 2 ? ORG_B : ORG_A))).toEqual([i % 2 ? 'b1' : 'a1']);
        }
      });
    });

    describe('回滾', () => {
      it('callback 拋例外時整個交易回滾，原本的錯誤原樣丟出', async () => {
        const boom = new Error('boom');
        await expect(
          withTx(orgCtx(ORG_A), async (tx) => {
            await tx.query('INSERT INTO org.tx_probe VALUES ($1, $2)', [ORG_A, 'half']);
            throw boom;
          }),
        ).rejects.toBe(boom);
        expect(await notes(orgCtx(ORG_A))).toEqual([]);
      });

      it('SQL 錯誤也整個回滾，之後的交易照常運作', async () => {
        await expect(
          withTx(orgCtx(ORG_A), async (tx) => {
            await tx.query('INSERT INTO org.tx_probe VALUES ($1, $2)', [ORG_A, 'half']);
            await tx.query('SELECT * FROM org.no_such_table');
          }),
        ).rejects.toThrow(/no_such_table/);
        await insert(ORG_A, 'after');
        expect(await notes(orgCtx(ORG_A))).toEqual(['after']);
      });

      it('正常結束就提交，回傳 callback 的值', async () => {
        const value = await withTx(orgCtx(ORG_A), async (tx) => {
          await tx.query('INSERT INTO org.tx_probe VALUES ($1, $2)', [ORG_A, 'kept']);
          return 42;
        });
        expect(value).toBe(42);
        expect(await notes(orgCtx(ORG_A))).toEqual(['kept']);
      });
    });

    describe('party 脈絡', () => {
      it('只設定 app.party_id', async () => {
        const ctx: DbContext = { kind: 'party', partyId: PARTY_P };
        expect(await setting(ctx, 'app.party_id')).toBe(PARTY_P);
        expect(await setting(ctx, 'app.org_id')).toBeFalsy();
      });
    });

    describe('operator 脈絡', () => {
      const operator = (ticketId: string): DbContext => ({ kind: 'operator', operatorId: OPERATOR_X, orgId: ORG_A, ticketId });

      it('設定目標組織，讀得到該組織的列、讀不到別的組織', async () => {
        await insert(ORG_A, 'a1');
        await insert(ORG_B, 'b1');
        expect(await notes(operator('CASE-1001'))).toEqual(['a1']);
      });

      it('另外設定營運者與工單號，供稽核紀錄的票讀取', async () => {
        const ctx = operator('CASE-1001');
        expect(await setting(ctx, 'app.org_id')).toBe(ORG_A);
        expect(await setting(ctx, 'app.operator_id')).toBe(OPERATOR_X);
        expect(await setting(ctx, 'app.ticket_id')).toBe('CASE-1001');
      });

      it.each(['', '   '])('工單號 %j 被拒絕', async (ticketId) => {
        await expect(withTx(operator(ticketId), async () => 1)).rejects.toThrow(/工單號/);
      });

      it('工單號含引號等特殊字元被拒絕', async () => {
        await expect(withTx(operator("x'; DROP TABLE org.tx_probe; --"), async () => 1)).rejects.toThrow(/工單號/);
      });
    });

    describe('值的格式檢查', () => {
      it.each([
        ['太短', 'ABC'],
        ['含小寫', '01jbkq0000000000000000000a'],
        ['含 I L O U', '01JBKQ000000000000000000IL'],
        ['注入字串', "x'; DROP TABLE org.tx_probe; --"],
        ['空字串', ''],
      ])('orgId %s 被拒絕，callback 不會執行', async (_name, bad) => {
        let ran = false;
        await expect(
          withTx(orgCtx(bad), async () => {
            ran = true;
          }),
        ).rejects.toThrow(/orgId/);
        expect(ran).toBe(false);
      });

      it('partyId、operatorId 同樣檢查', async () => {
        await expect(withTx({ kind: 'party', partyId: 'nope' }, async () => 1)).rejects.toThrow(/partyId/);
        await expect(
          withTx({ kind: 'org', orgId: ORG_A, partyId: 'nope' }, async () => 1),
        ).rejects.toThrow(/partyId/);
        await expect(
          withTx({ kind: 'operator', operatorId: 'nope', orgId: ORG_A, ticketId: 'T-1' }, async () => 1),
        ).rejects.toThrow(/operatorId/);
      });

      it('不認得的脈絡種類被拒絕', async () => {
        await expect(withTx({ kind: 'root' } as unknown as DbContext, async () => 1)).rejects.toThrow(/脈絡/);
      });
    });

    describe('逾時設定', () => {
      it('交易內的 statement_timeout 與 idle_in_transaction_session_timeout 已設定', async () => {
        const rows = await withTx(orgCtx(ORG_A), async (tx) => ({
          statement: (await tx.query<{ v: string }>("SELECT current_setting('statement_timeout') AS v")).rows[0].v,
          idle: (await tx.query<{ v: string }>("SELECT current_setting('idle_in_transaction_session_timeout') AS v")).rows[0].v,
        }));
        expect(rows).toEqual({ statement: '15s', idle: '10s' });
      });
    });

    describe('護欄', () => {
      it('withTx 不得巢狀呼叫', async () => {
        await expect(withTx(orgCtx(ORG_A), async () => withTx(orgCtx(ORG_A), async () => 1))).rejects.toThrow(/巢狀/);
        // 外層失敗後連線已釋放，之後的交易照常
        expect(await notes(orgCtx(ORG_A))).toEqual([]);
      });

      it('交易結束後再用 tx 會丟錯', async () => {
        const leaked = await withTx(orgCtx(ORG_A), async (tx) => tx);
        await expect(leaked.query('SELECT 1')).rejects.toThrow(/已結束/);
      });
    });

    describe('併發', () => {
      it('同時開多個交易，各自的組織脈絡不互相干擾', async () => {
        await insert(ORG_A, 'a1');
        await insert(ORG_B, 'b1');
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) => notes(orgCtx(i % 2 ? ORG_B : ORG_A))),
        );
        results.forEach((r, i) => expect(r).toEqual([i % 2 ? 'b1' : 'a1']));
      });
    });
  });
}
