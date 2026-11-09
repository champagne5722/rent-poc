import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerPaymentAccount } from '../payment-accounts';
import { pgliteDriver } from '../pg/drivers';
import { testCaseId } from '../pg/test-cases';
import { asRole, createTestDb, type TestDb } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import { changeSocialHousing, listSocialHousingChanges, resolveSocialHousingDefault } from './social-housing';

// MIL-123：社宅旗標的修改。seam 是 changeSocialHousing / listSocialHousingChanges / resolveSocialHousingDefault。
// 通知用 notify() 寫進同一個交易：站內通知看 org.notifications，email 看 org.notification_emails。

const CASE = testCaseId('CASEA1');
const MANDATE_CASE = testCaseId('CASEM1');
const OTHER_ORG_CASE = testCaseId('CASEB1');
const PARTY = newUlid();
const MANDATOR = newUlid();

describe('社宅旗標', () => {
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
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '好管家管理公司', 'practice'), ($2, 'B', 'practice')`, [orgA, orgB]);
    });
    await inA((tx) =>
      tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'mandator@example.com', '王屋主')`, [MANDATOR]),
    );
  });

  const inA = <T>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: orgA }, fn);

  const newCase = (id: string, over: { orgId?: string; businessType?: string; socialHousing?: boolean; kind?: 'lease' | 'management'; linked?: string } = {}) =>
    withTx({ kind: 'org', orgId: over.orgId ?? orgA }, (tx) =>
      tx.query(
        over.kind === 'management'
          ? `INSERT INTO org.cases (id, org_id, kind, state, title, social_housing) VALUES ($1, $2, 'management', 'active', '委託管理', $3)`
          : `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, social_housing, linked_mandate_case_id)
             VALUES ($1, $2, 'lease', 'active', $4, '板橋區某某路 3 樓', $3, $5)`,
        over.kind === 'management'
          ? [id, over.orgId ?? orgA, over.socialHousing ?? false]
          : [id, over.orgId ?? orgA, over.socialHousing ?? false, over.businessType ?? 'managed', over.linked ?? null],
      ),
    );

  const addMandator = (caseId: string) =>
    inA((tx) =>
      tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'mandator')`, [newUlid(), orgA, caseId, MANDATOR]),
    );

  const flagOf = async (caseId: string) =>
    (await inA((tx) => tx.query<{ social_housing: boolean }>(`SELECT social_housing FROM org.cases WHERE id = $1`, [caseId]))).rows[0].social_housing;

  const notifications = () =>
    inA((tx) => tx.query<{ kind: string; title: string; body: string; link_path: string }>(`SELECT kind, title, body, link_path FROM org.notifications ORDER BY id`)).then((r) => r.rows);
  const emails = () =>
    inA((tx) => tx.query<{ to_email: string; from_name: string; subject: string; body_text: string }>(`SELECT to_email, from_name, subject, body_text FROM org.notification_emails ORDER BY id`)).then((r) => r.rows);

  it('控制組：測試連線是 app_rw', async () => {
    expect((await db.query<{ u: string }>('SELECT current_user AS u')).rows[0].u).toBe('app_rw');
  });

  describe('changeSocialHousing', () => {
    it('改為社宅：旗標更新、寫修改紀錄與站內通知，回傳通知單據', async () => {
      await newCase(CASE);
      const result = await inA((tx) => changeSocialHousing(tx, { caseId: CASE, value: true, reason: '政府公告為社宅計畫', actorPartyId: PARTY }));
      expect(result).toMatchObject({ ok: true, changed: { from: false, to: true }, mandatorNotified: false, conflicts: [] });
      expect(await flagOf(CASE)).toBe(true);
      expect(await inA((tx) => listSocialHousingChanges(tx, CASE))).toEqual([
        expect.objectContaining({ caseId: CASE, fromValue: false, toValue: true, reason: '政府公告為社宅計畫', changedByPartyId: PARTY }),
      ]);
      const [note] = await notifications();
      expect(note).toMatchObject({ kind: 'case.social_housing_changed', link_path: `/cases/${CASE}` });
      expect(note.title).toContain('是');
      expect(note.body).toContain('政府公告為社宅計畫');
    });

    it('案件有委託人：同交易另寄 email 給委託人，寄件名義是主辦組織；回傳 outbox 單據供提交後派送', async () => {
      await newCase(MANDATE_CASE, { kind: 'management' });
      await addMandator(MANDATE_CASE);
      await newCase(CASE, { linked: MANDATE_CASE });
      const result = await inA((tx) => changeSocialHousing(tx, { caseId: CASE, value: true, reason: '標錯了', actorPartyId: PARTY }));
      expect(result).toMatchObject({ ok: true, mandatorNotified: true });
      if (!result.ok) return;
      expect(result.receipts.map((r) => r.outboxId)).toEqual([expect.any(String)]);
      expect(await emails()).toEqual([
        expect.objectContaining({ to_email: 'mandator@example.com', from_name: '好管家管理公司', body_text: expect.stringContaining('標錯了') }),
      ]);
    });

    it('改回非社宅：再寫一筆紀錄，兩次修改都留著', async () => {
      await newCase(CASE);
      await inA((tx) => changeSocialHousing(tx, { caseId: CASE, value: true, reason: '第一次', actorPartyId: PARTY }));
      const back = await inA((tx) => changeSocialHousing(tx, { caseId: CASE, value: false, reason: '標錯，改回來', actorPartyId: PARTY }));
      expect(back).toMatchObject({ ok: true, changed: { from: true, to: false } });
      expect(await flagOf(CASE)).toBe(false);
      const history = await inA((tx) => listSocialHousingChanges(tx, CASE));
      expect(history.map((h) => [h.fromValue, h.toValue, h.reason])).toEqual([
        [false, true, '第一次'],
        [true, false, '標錯，改回來'],
      ]);
    });

    it('改為社宅且押金放在代管業者帳戶：回傳衝突清單，既有分錄不變', async () => {
      await newCase(CASE);
      const account = await inA((tx) =>
        registerPaymentAccount(tx, { name: '業者帳戶', holderKind: 'manager', holderName: '好管家', method: 'bank', bankCode: '812', accountLast4: '0123' }, PARTY),
      );
      if (!account.ok) throw new Error('登錄帳戶失敗');
      await inA(async (tx) => {
        const journalId = newUlid();
        await tx.query(
          `INSERT INTO org.ledger_journals (id, org_id, case_id, business_event_type, business_event_id, effective_date) VALUES ($1, $2, $3, 'receipt_confirmed', 'E1', '2026-11-08')`,
          [journalId, orgA, CASE],
        );
        await tx.query(
          `INSERT INTO org.ledger_entries (id, org_id, case_id, journal_id, line_no, account, debit, credit) VALUES
             ($1, $2, $3, $4, 1, $5, 60000, 0), ($6, $2, $3, $4, 2, $7, 0, 60000)`,
          [newUlid(), orgA, CASE, journalId, `asset.bank.${account.id}`, newUlid(), `liability.deposit.${CASE}`],
        );
      });
      const before = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM org.ledger_entries')).rows[0].n;
      const result = await inA((tx) => changeSocialHousing(tx, { caseId: CASE, value: true, reason: '改為社宅', actorPartyId: PARTY }));
      expect(result).toMatchObject({ ok: true, conflicts: [expect.objectContaining({ paymentAccountId: account.id, action: 'block' })] });
      expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM org.ledger_entries')).rows[0].n).toBe(before);
    });

    it('原因空白：回傳 reason_required，什麼都不寫', async () => {
      await newCase(CASE);
      expect(await inA((tx) => changeSocialHousing(tx, { caseId: CASE, value: true, reason: '   ', actorPartyId: PARTY }))).toEqual({ ok: false, error: 'reason_required' });
      expect(await flagOf(CASE)).toBe(false);
      expect(await notifications()).toEqual([]);
    });

    it('原因超過 500 字：回傳 reason_too_long', async () => {
      await newCase(CASE);
      expect(await inA((tx) => changeSocialHousing(tx, { caseId: CASE, value: true, reason: '字'.repeat(501), actorPartyId: PARTY }))).toEqual({
        ok: false,
        error: 'reason_too_long',
      });
    });

    it('旗標沒有改變：回傳 unchanged，不寫紀錄也不通知', async () => {
      await newCase(CASE, { socialHousing: true });
      expect(await inA((tx) => changeSocialHousing(tx, { caseId: CASE, value: true, reason: '重複', actorPartyId: PARTY }))).toEqual({ ok: false, error: 'unchanged' });
      expect(await listSocialHousingChanges_(CASE)).toEqual([]);
      expect(await notifications()).toEqual([]);
    });

    it('自管案件不適用：回傳 not_applicable', async () => {
      await newCase(CASE, { businessType: 'self_managed' });
      expect(await inA((tx) => changeSocialHousing(tx, { caseId: CASE, value: true, reason: '嘗試', actorPartyId: PARTY }))).toEqual({ ok: false, error: 'not_applicable' });
      expect(await flagOf(CASE)).toBe(false);
    });

    it('包租案件得標記', async () => {
      await newCase(CASE, { businessType: 'master_lease' });
      expect((await inA((tx) => changeSocialHousing(tx, { caseId: CASE, value: true, reason: '社宅包租', actorPartyId: PARTY }))).ok).toBe(true);
    });

    it('案件不存在、別的組織的案件、委託管理案件：回傳 case_not_found', async () => {
      await newCase(OTHER_ORG_CASE, { orgId: orgB });
      await newCase(MANDATE_CASE, { kind: 'management' });
      for (const caseId of [testCaseId('MXSSNG'), OTHER_ORG_CASE, MANDATE_CASE]) {
        expect(await inA((tx) => changeSocialHousing(tx, { caseId, value: true, reason: '嘗試', actorPartyId: PARTY }))).toEqual({ ok: false, error: 'case_not_found' });
      }
    });

    it('稽核事件只放 ID 與旗標值，不放原因', async () => {
      await newCase(CASE);
      await inA((tx) => changeSocialHousing(tx, { caseId: CASE, value: true, reason: '這是機密的原因文字', actorPartyId: PARTY }));
      const events = await asRole(db, 'audit_owner', async () => {
        const { rows } = await db.query<{ action: string; payload: Record<string, unknown> }>(
          `SELECT action, payload FROM audit.events WHERE action = 'case.social_housing_change'`,
        );
        return rows;
      });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ from: false, to: true, change_id: expect.any(String) });
      expect(JSON.stringify(events)).not.toContain('機密');
    });

    it('與呼叫端同一個交易：呼叫端丟錯回滾時，旗標、紀錄與通知一起消失', async () => {
      await newCase(MANDATE_CASE, { kind: 'management' });
      await addMandator(MANDATE_CASE);
      await newCase(CASE, { linked: MANDATE_CASE });
      await expect(
        inA(async (tx) => {
          await changeSocialHousing(tx, { caseId: CASE, value: true, reason: '嘗試', actorPartyId: PARTY });
          throw new Error('後續步驟失敗');
        }),
      ).rejects.toThrow('後續步驟失敗');
      expect(await flagOf(CASE)).toBe(false);
      expect(await listSocialHousingChanges_(CASE)).toEqual([]);
      expect(await notifications()).toEqual([]);
      expect(await emails()).toEqual([]);
    });
  });

  const listSocialHousingChanges_ = (caseId: string) => inA((tx) => listSocialHousingChanges(tx, caseId));

  describe('resolveSocialHousingDefault：建立案件時的預設值', () => {
    it('沒有委託管理案件：預設 false', async () => {
      expect(await inA((tx) => resolveSocialHousingDefault(tx, null))).toBe(false);
    });

    it('有委託管理案件：帶入該案件的旗標', async () => {
      await newCase(MANDATE_CASE, { kind: 'management', socialHousing: true });
      expect(await inA((tx) => resolveSocialHousingDefault(tx, MANDATE_CASE))).toBe(true);
    });

    it('委託管理案件的旗標是 false 或案件看不到：預設 false', async () => {
      await newCase(MANDATE_CASE, { kind: 'management', socialHousing: false });
      expect(await inA((tx) => resolveSocialHousingDefault(tx, MANDATE_CASE))).toBe(false);
      expect(await inA((tx) => resolveSocialHousingDefault(tx, testCaseId('MXSSNG')))).toBe(false);
    });
  });
});
