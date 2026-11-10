import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from '../pg/drivers';
import { seedCases, testCaseId } from '../pg/test-cases';
import { asRole, createTestDb, type TestDb } from '../pg/test-harness';
import { seedOrgMember } from '../pg/test-parties';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import { registerPaymentAccount, deactivatePaymentAccount } from '../payment-accounts';
import { getDefaultAccounts, setDefaultAccounts } from './default-accounts';

// MIL-123：案件的租金與押金預設收款帳戶，只用來預填入帳表單。
// seam 是 setDefaultAccounts / getDefaultAccounts。帳戶用 payment-accounts 模組的公開函式登錄。

const CASE = testCaseId('CASEA1');
const OTHER_ORG_CASE = testCaseId('CASEB1');
// 持有人必須是真實的組織成員（MIL-187），每個測試開始時建立，兩個組織各一位
const PARTY: Record<'a' | 'b', string> = { a: '', b: '' };

describe('案件的預設收款帳戶', () => {
  let testDb: TestDb;
  let db: PGliteInterface;
  let withTx: WithTx;
  const orgA = newUlid();
  const orgB = newUlid();

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());

  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', async () => {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]);
    });
    PARTY.a = await seedOrgMember(withTx, orgA);
    PARTY.b = await seedOrgMember(withTx, orgB);
    await seedCases(withTx, [orgA], [CASE]);
    await seedCases(withTx, [orgB], [OTHER_ORG_CASE]);
  });

  const inA = <T>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: orgA }, fn);
  const inB = <T>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: orgB }, fn);

  async function newAccount(orgId: string, name: string): Promise<string> {
    const result = await withTx({ kind: 'org', orgId }, (tx) =>
      registerPaymentAccount(
        tx,
        { name, holderKind: 'lessor', holderName: '王大明', method: 'bank', bankCode: '812', accountLast4: '0123' },
        orgId === orgB ? PARTY.b : PARTY.a,
      ),
    );
    if (!result.ok) throw new Error(`登錄帳戶失敗：${result.error}`);
    return result.id;
  }

  it('控制組：測試連線是 app_rw', async () => {
    expect((await db.query<{ u: string }>('SELECT current_user AS u')).rows[0].u).toBe('app_rw');
  });

  it('新案件沒有預設帳戶', async () => {
    expect(await inA((tx) => getDefaultAccounts(tx, CASE))).toEqual({ rentAccountId: null, depositAccountId: null });
  });

  it('租金與押金各設一個預設帳戶；只傳一個時另一個不變；傳 null 清除', async () => {
    const rent = await newAccount(orgA, '租金帳戶');
    const deposit = await newAccount(orgA, '押金帳戶');
    expect(await inA((tx) => setDefaultAccounts(tx, CASE, { rentAccountId: rent }))).toEqual({ ok: true });
    expect(await inA((tx) => getDefaultAccounts(tx, CASE))).toEqual({ rentAccountId: rent, depositAccountId: null });
    expect(await inA((tx) => setDefaultAccounts(tx, CASE, { depositAccountId: deposit }))).toEqual({ ok: true });
    expect(await inA((tx) => getDefaultAccounts(tx, CASE))).toEqual({ rentAccountId: rent, depositAccountId: deposit });
    expect(await inA((tx) => setDefaultAccounts(tx, CASE, { rentAccountId: null }))).toEqual({ ok: true });
    expect(await inA((tx) => getDefaultAccounts(tx, CASE))).toEqual({ rentAccountId: null, depositAccountId: deposit });
  });

  it('租金與押金得設同一個帳戶', async () => {
    const both = await newAccount(orgA, '共用帳戶');
    expect(await inA((tx) => setDefaultAccounts(tx, CASE, { rentAccountId: both, depositAccountId: both }))).toEqual({ ok: true });
  });

  it('別的組織的帳戶、不存在的帳戶、已停用的帳戶：回傳 account_not_usable，兩個欄位都不變', async () => {
    const mine = await newAccount(orgA, '我的');
    const theirs = await newAccount(orgB, '別人的');
    const stopped = await newAccount(orgA, '已停用');
    await inA((tx) => deactivatePaymentAccount(tx, stopped));
    await inA((tx) => setDefaultAccounts(tx, CASE, { rentAccountId: mine }));

    for (const bad of [theirs, newUlid(), stopped, 'not-a-ulid']) {
      expect(await inA((tx) => setDefaultAccounts(tx, CASE, { rentAccountId: mine, depositAccountId: bad }))).toEqual({
        ok: false,
        error: 'account_not_usable',
      });
    }
    expect(await inA((tx) => getDefaultAccounts(tx, CASE))).toEqual({ rentAccountId: mine, depositAccountId: null });
  });

  it('案件不存在或是別的組織的案件：回傳 case_not_found', async () => {
    const mine = await newAccount(orgA, '我的');
    expect(await inA((tx) => setDefaultAccounts(tx, OTHER_ORG_CASE, { rentAccountId: mine }))).toEqual({ ok: false, error: 'case_not_found' });
    expect(await inA((tx) => setDefaultAccounts(tx, testCaseId('MXSSNG'), { rentAccountId: mine }))).toEqual({ ok: false, error: 'case_not_found' });
    expect(await inB((tx) => getDefaultAccounts(tx, CASE))).toBeNull();
  });

  it('什麼都沒傳時不寫資料', async () => {
    expect(await inA((tx) => setDefaultAccounts(tx, CASE, {}))).toEqual({ ok: true });
  });

  it('稽核事件只放帳戶 ID', async () => {
    const rent = await newAccount(orgA, '租金帳戶');
    await inA((tx) => setDefaultAccounts(tx, CASE, { rentAccountId: rent }));
    const events = await asRole(db, 'audit_owner', async () => {
      const { rows } = await db.query<{ action: string; payload: Record<string, unknown> }>(
        `SELECT action, payload FROM audit.events WHERE action = 'case.default_accounts_set'`,
      );
      return rows;
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ rent_account_id: rent });
  });
});
