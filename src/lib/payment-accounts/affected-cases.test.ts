import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from '../pg/drivers';
import { asRole, createTestDb, type TestDb } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import { listAffectedCases } from './affected-cases';
import { parsePaymentAccountInput } from './input';
import { deactivatePaymentAccount, registerPaymentAccount } from './repository';

// MIL-118：「列出受影響案件」。案件表在 C 線，這裡以合約代替案件。
// 規則的社宅與委託範圍條件在合約上沒有欄位，先忽略（MIL-125 有持有人確認紀錄後改成依確認紀錄列出）。

describe('listAffectedCases（以合約代替案件）', () => {
  let testDb: TestDb;
  let db: PGliteInterface;
  let withTx: WithTx;
  const orgA = newUlid();
  const orgB = newUlid();
  const PARTY = newUlid();

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', () =>
      db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]),
    );
  });
  const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);
  const inA = <T>(fn: (tx: OrgTx) => Promise<T>) => inOrg(orgA, fn);

  async function contract(type: 'lease' | 'management', status = 'completed', orgId = orgA): Promise<string> {
    const id = newUlid();
    await inOrg(orgId, (tx) =>
      tx.query(`INSERT INTO org.contracts (id, org_id, contract_type, status) VALUES ($1, $2, $3, $4)`, [id, orgId, type, status]),
    );
    return id;
  }

  async function account(holderKind: string, orgId = orgA): Promise<string> {
    const parsed = parsePaymentAccountInput({ name: '帳戶', holderKind, holderName: '持有人', method: 'bank', bankCode: '812', accountLast4: '0123' });
    if (!parsed.ok) throw new Error(parsed.error);
    const result = await inOrg(orgId, (tx) => registerPaymentAccount(tx, parsed.value, holderKind === 'other' ? null : PARTY));
    if (!result.ok) throw new Error(result.error);
    return result.id;
  }

  it('DHR-02 是代管、代管業者持有：列出本組織已完成的委託管理合約', async () => {
    const managed = await contract('management');
    await contract('lease');
    await account('manager');
    const result = await inA((tx) => listAffectedCases(tx, 'DHR-02', 1));
    expect(result).toEqual({
      ok: true,
      cases: [{ contractId: managed, contractType: 'management' }],
    });
  });

  it('DHR-04 是包租、出租人持有：列出租賃合約', async () => {
    const lease = await contract('lease');
    await contract('management');
    await account('lessor');
    expect(await inA((tx) => listAffectedCases(tx, 'DHR-04', 1))).toEqual({
      ok: true,
      cases: [{ contractId: lease, contractType: 'lease' }],
    });
  });

  it('萬用列 DHR-05 條件不限：所有已完成的合約都列出，新的在前', async () => {
    const first = await contract('lease');
    const second = await contract('management');
    await account('other');
    const result = await inA((tx) => listAffectedCases(tx, 'DHR-05', 1));
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.cases.map((c) => c.contractId)).toEqual([second, first]);
  });

  it('組織沒有符合持有人種類的啟用中收款帳戶時，不列出任何案件', async () => {
    await contract('management');
    await account('lessor');
    expect(await inA((tx) => listAffectedCases(tx, 'DHR-02', 1))).toEqual({ ok: true, cases: [] });
  });

  it('持有人種類符合的帳戶都停用後，不列出任何案件', async () => {
    await contract('management');
    const id = await account('manager');
    const cashIds = await inA(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(`SELECT id FROM org.payment_accounts WHERE account_kind = 'cash'`);
      return rows.map((r) => r.id);
    });
    for (const accountId of [id, ...cashIds]) await inA((tx) => deactivatePaymentAccount(tx, accountId));
    expect(await inA((tx) => listAffectedCases(tx, 'DHR-02', 1))).toEqual({ ok: true, cases: [] });
  });

  it('草稿、已拒簽、已撤回的合約不是既有案件', async () => {
    await contract('management', 'draft');
    await contract('management', 'declined');
    await contract('management', 'voided');
    await contract('management', 'awaiting_tenant');
    await account('manager');
    expect(await inA((tx) => listAffectedCases(tx, 'DHR-02', 1))).toEqual({ ok: true, cases: [] });
  });

  it('不列出別的組織的合約', async () => {
    await contract('management', 'completed', orgB);
    await account('manager');
    expect(await inA((tx) => listAffectedCases(tx, 'DHR-02', 1))).toEqual({ ok: true, cases: [] });
  });

  it('依版本查：規則有新版本時，舊版本的列仍可查；沒有的版本回 rule_not_found', async () => {
    await contract('management');
    await account('manager');
    await asRole(db, 'app_owner', () =>
      db.query(
        `INSERT INTO control.deposit_holder_rules
           (rule_id, version, business_type, social_housing, holder_kind, mandate_includes_deposit, action, notify_mandator)
         VALUES ('DHR-02', 2, 'managed', false, 'lessor', true, 'block', true)`,
      ),
    );
    expect(await inA((tx) => listAffectedCases(tx, 'DHR-02', 1))).toMatchObject({ ok: true, cases: [expect.anything()] });
    // 版本 2 的持有人種類是 lessor，這個組織只有代管業者的帳戶
    expect(await inA((tx) => listAffectedCases(tx, 'DHR-02', 2))).toEqual({ ok: true, cases: [] });
    expect(await inA((tx) => listAffectedCases(tx, 'DHR-02', 3))).toEqual({ ok: false, error: 'rule_not_found' });
    expect(await inA((tx) => listAffectedCases(tx, 'DHR-99', 1))).toEqual({ ok: false, error: 'rule_not_found' });
  });
});
