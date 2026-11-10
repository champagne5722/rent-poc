import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEPOSIT_HOLDER_RULES, evaluateHolderRule } from '../deposit-rules';
import { pgliteDriver } from '../pg/drivers';
import { asRole, createTestDb, type TestDb } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import { loadHolderRules } from './holder-rules-store';

// MIL-118：control.deposit_holder_rules 由 migration 寫入 5 列，app_rw 只能讀。
// 缺列時 DHR-05 萬用列消失，evaluateHolderRule 會回 warn 而不是 allow，所以這裡檢查 5 列都在。

describe('control.deposit_holder_rules', () => {
  let testDb: TestDb;
  let db: PGliteInterface;
  let withTx: WithTx;
  const org = newUlid();

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', () => db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner')`, [org]));
  });
  const inOrg = <T>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: org }, fn);

  it('控制組：測試連線是 app_rw', async () => {
    const { rows } = await db.query<{ u: string }>('SELECT current_user AS u');
    expect(rows[0].u).toBe('app_rw');
  });

  it('migration 寫入的正好是 DHR-01 到 DHR-05，版本都是 1', async () => {
    const rules = await inOrg((tx) => loadHolderRules(tx));
    expect(rules.map((r) => [r.ruleId, r.version]).sort()).toEqual([
      ['DHR-01', 1],
      ['DHR-02', 1],
      ['DHR-03', 1],
      ['DHR-04', 1],
      ['DHR-05', 1],
    ]);
  });

  it('資料庫的每一列與 DEPOSIT_HOLDER_RULES 常數逐欄相同', async () => {
    const rules = await inOrg((tx) => loadHolderRules(tx));
    const byId = (list: readonly { ruleId: string }[]) => [...list].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
    expect(byId(rules)).toEqual(byId(DEPOSIT_HOLDER_RULES));
  });

  it('萬用列 DHR-05 在：沒有具體規則命中的組合放行', async () => {
    const rules = await inOrg((tx) => loadHolderRules(tx));
    const result = evaluateHolderRule(rules, {
      caseKind: 'lease',
      businessType: 'self_managed',
      socialHousing: false,
      holderKind: 'other',
      mandateIncludesDeposit: false,
    });
    expect(result).toMatchObject({ action: 'allow', ruleId: 'DHR-05', ruleVersion: 1 });
  });

  it('資料庫讀出的規則判定社宅代管業者持有為阻擋', async () => {
    const rules = await inOrg((tx) => loadHolderRules(tx));
    const result = evaluateHolderRule(rules, {
      caseKind: 'lease',
      businessType: 'managed',
      socialHousing: true,
      holderKind: 'manager',
      mandateIncludesDeposit: true,
    });
    expect(result).toMatchObject({ action: 'block', ruleId: 'DHR-01' });
  });

  it('同一個 rule_id 有新版本時只取最新版本', async () => {
    await asRole(db, 'app_owner', () =>
      db.query(
        `INSERT INTO control.deposit_holder_rules
           (rule_id, version, business_type, social_housing, holder_kind, mandate_includes_deposit, action, notify_mandator)
         VALUES ('DHR-02', 2, 'managed', false, 'manager', true, 'block', true)`,
      ),
    );
    const rules = await inOrg((tx) => loadHolderRules(tx));
    expect(rules).toHaveLength(5);
    expect(rules.find((r) => r.ruleId === 'DHR-02')).toMatchObject({ version: 2, action: 'block' });
  });

  it('app_rw 不能新增、修改、刪除、清空規則列', async () => {
    await expect(
      inOrg((tx) =>
        tx.query(`INSERT INTO control.deposit_holder_rules (rule_id, version, action, notify_mandator) VALUES ('DHR-99', 1, 'allow', false)`),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(inOrg((tx) => tx.query(`UPDATE control.deposit_holder_rules SET action = 'allow'`))).rejects.toThrow(/permission denied/);
    await expect(inOrg((tx) => tx.query('DELETE FROM control.deposit_holder_rules'))).rejects.toThrow(/permission denied/);
    await expect(inOrg((tx) => tx.query('TRUNCATE control.deposit_holder_rules'))).rejects.toThrow(/permission denied/);
    const rules = await inOrg((tx) => loadHolderRules(tx));
    expect(rules).toHaveLength(5);
  });

  it('資料庫約束擋下不合法的動作與業務類型', async () => {
    await expect(
      asRole(db, 'app_owner', () =>
        db.query(`INSERT INTO control.deposit_holder_rules (rule_id, version, action, notify_mandator) VALUES ('DHR-98', 1, 'maybe', false)`),
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      asRole(db, 'app_owner', () =>
        db.query(`INSERT INTO control.deposit_holder_rules (rule_id, version, business_type, action, notify_mandator) VALUES ('DHR-97', 1, 'sale', 'allow', false)`),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
