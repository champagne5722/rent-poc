import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from '../pg/drivers';
import { seedCases, testCaseId } from '../pg/test-cases';
import { asRole, createTestDb, type TestDb } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import { addRemitterId, listRemitterIds, removeRemitterId } from './remitters';

// MIL-123：案件登錄 0 到多筆匯款識別。seam 是 addRemitterId / listRemitterIds / removeRemitterId 的回傳值。

const CASE = testCaseId('CASEA1');
const CASE2 = testCaseId('CASEA2');
const OTHER_ORG_CASE = testCaseId('CASEB1');

describe('匯款識別', () => {
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
    await seedCases(withTx, [orgA], [CASE, CASE2]);
    await seedCases(withTx, [orgB], [OTHER_ORG_CASE]);
  });

  const inA = <T>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: orgA }, fn);
  const inB = <T>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: orgB }, fn);

  it('控制組：測試連線是 app_rw', async () => {
    expect((await db.query<{ u: string }>('SELECT current_user AS u')).rows[0].u).toBe('app_rw');
  });

  it('新案件沒有匯款識別（0 筆）', async () => {
    expect(await inA((tx) => listRemitterIds(tx, CASE))).toEqual([]);
  });

  it('登錄多筆，戶名存正規化後的值', async () => {
    const name = await inA((tx) => addRemitterId(tx, CASE, { kind: 'payer_name', value: ' 王　大明 ' }));
    const last5 = await inA((tx) => addRemitterId(tx, CASE, { kind: 'account_last5', value: '12345' }));
    expect(name).toEqual({ ok: true, id: expect.any(String) });
    expect(last5).toEqual({ ok: true, id: expect.any(String) });
    const list = await inA((tx) => listRemitterIds(tx, CASE));
    expect(list.map((r) => [r.kind, r.value])).toEqual([
      ['payer_name', '王 大明'],
      ['account_last5', '12345'],
    ]);
  });

  it('同一案件重複登錄同一個識別：回傳 duplicate，不丟錯；全形與半形視為同一個', async () => {
    await inA((tx) => addRemitterId(tx, CASE, { kind: 'account_last5', value: '12345' }));
    expect(await inA((tx) => addRemitterId(tx, CASE, { kind: 'account_last5', value: '１２３４５' }))).toEqual({ ok: false, error: 'duplicate' });
    expect(await inA((tx) => listRemitterIds(tx, CASE))).toHaveLength(1);
  });

  it('不同案件得登錄同一個識別', async () => {
    await inA((tx) => addRemitterId(tx, CASE, { kind: 'payer_name', value: '王大明' }));
    expect((await inA((tx) => addRemitterId(tx, CASE2, { kind: 'payer_name', value: '王大明' }))).ok).toBe(true);
  });

  it('輸入不合格：回傳 invalid_input 與訊息，什麼都不寫', async () => {
    const result = await inA((tx) => addRemitterId(tx, CASE, { kind: 'account_last5', value: '12' }));
    expect(result).toEqual({ ok: false, error: 'invalid_input', message: expect.any(String) });
    expect(await inA((tx) => listRemitterIds(tx, CASE))).toEqual([]);
  });

  it('案件不存在、別的組織的案件、委託管理案件：回傳 case_not_found', async () => {
    const managementCase = testCaseId('CASEM1');
    await inA((tx) =>
      tx.query(`INSERT INTO org.cases (id, org_id, kind, state, title) VALUES ($1, $2, 'management', 'draft', '委託管理')`, [managementCase, orgA]),
    );
    for (const caseId of [testCaseId('MXSSNG'), OTHER_ORG_CASE, managementCase]) {
      expect(await inA((tx) => addRemitterId(tx, caseId, { kind: 'payer_name', value: '王大明' }))).toEqual({ ok: false, error: 'case_not_found' });
    }
  });

  it('移除：回傳是否移除；別的案件、別的組織的識別移不掉', async () => {
    const added = await inA((tx) => addRemitterId(tx, CASE, { kind: 'payer_name', value: '王大明' }));
    if (!added.ok) throw new Error('測試資料寫入失敗');
    expect(await inB((tx) => removeRemitterId(tx, CASE, added.id))).toBe(false);
    expect(await inA((tx) => removeRemitterId(tx, CASE2, added.id))).toBe(false);
    expect(await inA((tx) => removeRemitterId(tx, CASE, added.id))).toBe(true);
    expect(await inA((tx) => removeRemitterId(tx, CASE, added.id))).toBe(false);
    expect(await inA((tx) => listRemitterIds(tx, CASE))).toEqual([]);
  });

  it('別的組織讀不到', async () => {
    await inA((tx) => addRemitterId(tx, CASE, { kind: 'payer_name', value: '王大明' }));
    expect(await inB((tx) => listRemitterIds(tx, CASE))).toEqual([]);
  });

  it('稽核事件只記種類，不記戶名與帳號', async () => {
    const added = await inA((tx) => addRemitterId(tx, CASE, { kind: 'payer_name', value: '王大明' }));
    if (!added.ok) throw new Error('測試資料寫入失敗');
    await inA((tx) => removeRemitterId(tx, CASE, added.id));
    const events = await asRole(db, 'audit_owner', async () => {
      const { rows } = await db.query<{ action: string; payload: unknown }>(
        `SELECT action, payload FROM audit.events WHERE action LIKE 'case_remitter.%' ORDER BY seq`,
      );
      return rows;
    });
    expect(events.map((e) => e.action)).toEqual(['case_remitter.add', 'case_remitter.remove']);
    expect(JSON.stringify(events)).not.toContain('王大明');
  });
});
