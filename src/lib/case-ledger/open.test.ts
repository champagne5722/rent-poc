import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from '../pg/drivers';
import { seedCases, testCaseId } from '../pg/test-cases';
import { asRole, createTestDb, type TestDb } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import { cancelPeriodsAfterTermination, openCaseLedger, type LeaseTerms } from './open';
import { getDepositLedger, listPeriods } from './reads';

// MIL-123：合約全員完成時建立押金台帳與應收期別。seam 是 openCaseLedger / cancelPeriodsAfterTermination 的回傳值，
// 加上 reads 的讀取函式。期別切分的細節（月底、閏年、跨年）在 src/lib/receivables 的表格測試，這裡只驗接線。
// 期望值是手算的字面值，不由被測的函式重算。

const CASE = testCaseId('CASEA1');

const terms = (over: Partial<LeaseTerms> = {}): LeaseTerms => ({
  deposit: 60000,
  startDate: '2026-11-01',
  endDate: '2027-01-31',
  payDay: 5,
  rent: 30000,
  ...over,
});

describe('openCaseLedger 與 cancelPeriodsAfterTermination', () => {
  let testDb: TestDb;
  let db: PGliteInterface;
  let withTx: WithTx;
  const orgA = newUlid();

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());

  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', async () => {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner')`, [orgA]);
    });
    await seedCases(withTx, [orgA], [CASE]);
  });

  const inA = <T>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: orgA }, fn);

  it('控制組：測試連線是 app_rw', async () => {
    expect((await db.query<{ u: string }>('SELECT current_user AS u')).rows[0].u).toBe('app_rw');
  });

  it('建立押金台帳與全部應收期別，約定金額取合約的押金', async () => {
    const result = await inA((tx) => openCaseLedger(tx, CASE, terms()));
    expect(result).toMatchObject({ opened: true, periodCount: 3, periodsSkipped: null });

    expect(await inA((tx) => getDepositLedger(tx, CASE))).toMatchObject({ caseId: CASE, expectedAmount: 60000, status: 'open' });
    const periods = await inA((tx) => listPeriods(tx, CASE));
    expect(periods.map((p) => [p.periodKey, p.periodStart, p.periodEnd, p.dueDate, p.amount, p.state])).toEqual([
      ['2026-11', '2026-11-01', '2026-11-30', '2026-11-05', 30000, 'active'],
      ['2026-12', '2026-12-01', '2026-12-31', '2026-12-05', 30000, 'active'],
      ['2027-01', '2027-01-01', '2027-01-31', '2027-01-05', 30000, 'active'],
    ]);
  });

  it('首末期不足一個月時依日數比例計算，四捨五入到元（待訪談驗證的假設）', async () => {
    // 11/16 到 11/30 共 15 天，11 月 30 天：15000。1/1 到 1/15 共 15 天，1 月 31 天：30000 × 15 / 31 = 14516.1，取 14516
    await inA((tx) => openCaseLedger(tx, CASE, terms({ startDate: '2026-11-16', endDate: '2027-01-15' })));
    const periods = await inA((tx) => listPeriods(tx, CASE));
    expect(periods.map((p) => [p.periodKey, p.amount, p.dueDate])).toEqual([
      ['2026-11', 15000, '2026-11-16'],
      ['2026-12', 30000, '2026-12-05'],
      ['2027-01', 14516, '2027-01-05'],
    ]);
  });

  it('付款日 31 日遇到沒有 31 日的月份時，到期日取月底', async () => {
    await inA((tx) => openCaseLedger(tx, CASE, terms({ startDate: '2027-02-01', endDate: '2027-03-31', payDay: 31 })));
    const periods = await inA((tx) => listPeriods(tx, CASE));
    expect(periods.map((p) => [p.periodKey, p.dueDate])).toEqual([
      ['2027-02', '2027-02-28'],
      ['2027-03', '2027-03-31'],
    ]);
  });

  it('合約沒填押金時，約定金額是 0', async () => {
    await inA((tx) => openCaseLedger(tx, CASE, terms({ deposit: null })));
    expect(await inA((tx) => getDepositLedger(tx, CASE))).toMatchObject({ expectedAmount: 0 });
  });

  it('重複呼叫不會重複建立，回傳 already_open', async () => {
    await inA((tx) => openCaseLedger(tx, CASE, terms()));
    const again = await inA((tx) => openCaseLedger(tx, CASE, terms({ deposit: 99999 })));
    expect(again).toEqual({ opened: false, reason: 'already_open' });
    expect(await inA((tx) => getDepositLedger(tx, CASE))).toMatchObject({ expectedAmount: 60000 });
    expect(await inA((tx) => listPeriods(tx, CASE))).toHaveLength(3);
  });

  it.each([
    ['沒有付款日', { payDay: null }],
    ['沒有月租', { rent: null }],
    ['租期起日格式不對', { startDate: '' }],
    ['租期迄日早於起日', { endDate: '2026-10-01' }],
  ] as const)('%s：押金台帳照建，期別跳過並回報原因，不丟錯（不擋住完成事件）', async (_name, over) => {
    const result = await inA((tx) => openCaseLedger(tx, CASE, terms(over)));
    expect(result).toMatchObject({ opened: true, periodCount: 0 });
    if (result.opened) expect(result.periodsSkipped).toEqual(expect.any(String));
    expect(await inA((tx) => getDepositLedger(tx, CASE))).not.toBeNull();
    expect(await inA((tx) => listPeriods(tx, CASE))).toEqual([]);
  });

  it('與呼叫端同一個交易：呼叫端丟錯回滾時，台帳與期別一起消失', async () => {
    await expect(
      inA(async (tx) => {
        await openCaseLedger(tx, CASE, terms());
        throw new Error('完成事件的其他步驟失敗');
      }),
    ).rejects.toThrow('完成事件的其他步驟失敗');
    expect(await inA((tx) => getDepositLedger(tx, CASE))).toBeNull();
    expect(await inA((tx) => listPeriods(tx, CASE))).toEqual([]);
  });

  it('案件不存在時丟錯（外鍵擋下）', async () => {
    await expect(inA((tx) => openCaseLedger(tx, testCaseId('MXSSNG'), terms()))).rejects.toThrow(/foreign key/i);
  });

  describe('合約提前終止', () => {
    it('終止日之後才開始的期別改 cancelled，終止日所在的期別不調整', async () => {
      await inA((tx) => openCaseLedger(tx, CASE, terms()));
      const cancelled = await inA((tx) => cancelPeriodsAfterTermination(tx, CASE, '2026-12-10'));
      expect(cancelled).toEqual(['2027-01']);
      const periods = await inA((tx) => listPeriods(tx, CASE));
      expect(periods.map((p) => [p.periodKey, p.state, p.amount])).toEqual([
        ['2026-11', 'active', 30000],
        ['2026-12', 'active', 30000],
        ['2027-01', 'cancelled', 30000],
      ]);
    });

    it('終止日恰好是期別起日時，該期不取消；重複呼叫不再取消任何期別', async () => {
      await inA((tx) => openCaseLedger(tx, CASE, terms()));
      expect(await inA((tx) => cancelPeriodsAfterTermination(tx, CASE, '2026-12-01'))).toEqual(['2027-01']);
      expect(await inA((tx) => cancelPeriodsAfterTermination(tx, CASE, '2026-12-01'))).toEqual([]);
    });

    it('終止日早於整份租期時，全部期別取消', async () => {
      await inA((tx) => openCaseLedger(tx, CASE, terms()));
      expect(await inA((tx) => cancelPeriodsAfterTermination(tx, CASE, '2026-10-31'))).toEqual(['2026-11', '2026-12', '2027-01']);
    });

    it('終止日格式不對時丟 RangeError', async () => {
      await inA((tx) => openCaseLedger(tx, CASE, terms()));
      await expect(inA((tx) => cancelPeriodsAfterTermination(tx, CASE, '2026/12/10'))).rejects.toThrow(RangeError);
    });
  });
});
