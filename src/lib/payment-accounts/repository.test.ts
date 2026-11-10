import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from '../pg/drivers';
import { seedCases, testCaseId } from '../pg/test-cases';
import { asRole, createTestDb, type TestDb } from '../pg/test-harness';
import { seedCaseMember, seedOrgMember, seedParty } from '../pg/test-parties';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import { parsePaymentAccountInput, type PaymentAccountInput } from './input';
import {
  assertPaymentAccountsInOrg,
  deactivatePaymentAccount,
  getPaymentAccount,
  listPaymentAccounts,
  registerPaymentAccount,
  updatePaymentAccount,
} from './repository';

// MIL-118：收款帳戶 repository 經 withTx 寫進 PGlite。連線身分是 app_rw（fresh() 保證），RLS 生效。
// 分錄用原始 SQL 寫入：鏡像帳的寫入入口只准 ledger 目錄呼叫（post.guard.test.ts），這裡只需要「有分錄引用這個帳戶」。

// 持有人必須是真實的 party，並且在本組織的成員或案件成員清單內（MIL-187）。每個測試開始時由 beforeEach 建立
let PARTY = '';
let PARTY_B = '';

function input(over: Record<string, unknown> = {}): PaymentAccountInput {
  const parsed = parsePaymentAccountInput({
    name: '王先生的台新帳戶',
    holderKind: 'lessor',
    holderName: '王大明',
    method: 'bank',
    bankCode: '812',
    accountLast4: '0123',
    ...over,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe('收款帳戶 repository', () => {
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
    await asRole(db, 'app_owner', () =>
      db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]),
    );
    PARTY = await seedOrgMember(withTx, orgA, '王大明');
    PARTY_B = await seedOrgMember(withTx, orgB, '乙組織成員');
  });

  const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);
  const inA = <T>(fn: (tx: OrgTx) => Promise<T>) => inOrg(orgA, fn);

  async function register(over: Record<string, unknown> = {}, partyId: string | null = PARTY, orgId = orgA) {
    const result = await inOrg(orgId, (tx) => registerPaymentAccount(tx, input(over), partyId));
    if (!result.ok) throw new Error(`登錄失敗：${result.error}`);
    return result;
  }

  /** 讓一筆分錄引用這個收款帳戶。 */
  async function referenceInLedger(accountId: string, orgId = orgA): Promise<void> {
    await inOrg(orgId, async (tx) => {
      // 鏡像帳的 case_id 掛了 org.cases 的複合外鍵（MIL-123），分錄需要一個真實的案件
      const caseId = newUlid();
      await tx.query(
        `INSERT INTO org.cases (id, org_id, kind, state, business_type, title)
         VALUES ($1, $2, 'lease', 'active', 'self_managed', '測試案件')`,
        [caseId, orgId],
      );
      const journalId = newUlid();
      await tx.query(
        `INSERT INTO org.ledger_journals (id, org_id, case_id, business_event_type, business_event_id, effective_date)
         VALUES ($1, $2, $3, 'receipt_confirmed', $4, '2026-11-08')`,
        [journalId, orgId, caseId, newUlid()],
      );
      await tx.query(
        `INSERT INTO org.ledger_entries (id, org_id, case_id, journal_id, line_no, account, debit, credit) VALUES
           ($1, $2, $3, $4, 1, $5, 100, 0),
           ($6, $2, $3, $4, 2, $7, 0, 100)`,
        [newUlid(), orgId, caseId, journalId, `asset.bank.${accountId}`, newUlid(), `liability.deposit.${caseId}`],
      );
    });
  }

  const auditActions = () =>
    asRole(db, 'audit_owner', async () => {
      const { rows } = await db.query<{ action: string; payload: Record<string, unknown>; object_id: string }>(
        `SELECT action, payload, object_id FROM audit.events WHERE action LIKE 'payment_account.%' ORDER BY seq`,
      );
      return rows;
    });

  it('控制組：測試連線是 app_rw', async () => {
    const { rows } = await db.query<{ u: string }>('SELECT current_user AS u');
    expect(rows[0].u).toBe('app_rw');
  });

  describe('登錄', () => {
    it('登錄銀行帳戶：只存遮罩識別，回傳的帳戶有 ULID、名稱、持有人與啟用狀態', async () => {
      const { id } = await register();
      const account = await inA((tx) => getPaymentAccount(tx, id));
      expect(account).toEqual({
        id,
        name: '王先生的台新帳戶',
        holderKind: 'lessor',
        holderPartyId: PARTY,
        holderName: '王大明',
        isCash: false,
        bankCode: '812',
        accountLast4: '0123',
        active: true,
        locked: false,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    it('登錄銀行帳戶時，同交易為該持有人補一個現金收取帳戶', async () => {
      const result = await register();
      expect(result.cashAccountId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      const accounts = await inA((tx) => listPaymentAccounts(tx));
      expect(accounts).toHaveLength(2);
      const cash = accounts.find((a) => a.isCash)!;
      expect(cash).toMatchObject({
        id: result.cashAccountId,
        name: '王大明 現金收取',
        holderKind: 'lessor',
        holderName: '王大明',
        bankCode: null,
        accountLast4: null,
        active: true,
      });
    });

    it('同一位持有人再登錄銀行帳戶，不會再補現金收取帳戶', async () => {
      await register();
      const second = await register({ name: '第二個帳戶', accountLast4: '9999' });
      expect(second.cashAccountId).toBeNull();
      expect((await inA((tx) => listPaymentAccounts(tx))).filter((a) => a.isCash)).toHaveLength(1);
    });

    it('持有人的現金收取帳戶停用後，再登錄銀行帳戶會補一個新的', async () => {
      const first = await register();
      await inA((tx) => deactivatePaymentAccount(tx, first.cashAccountId!));
      const second = await register({ name: '第二個帳戶', accountLast4: '9999' });
      expect(second.cashAccountId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect((await inA((tx) => listPaymentAccounts(tx))).filter((a) => a.isCash && a.active)).toHaveLength(1);
    });

    it('不同持有人各有一個現金收取帳戶：同一個 party 的出租人與代管業者各算各的', async () => {
      await register();
      await register({ holderKind: 'manager', holderName: '好管家公司', name: '好管家帳戶' });
      const cash = (await inA((tx) => listPaymentAccounts(tx))).filter((a) => a.isCash);
      expect(cash.map((a) => a.holderKind).sort()).toEqual(['lessor', 'manager']);
    });

    it('明確登錄現金收取：持有人已有現金收取帳戶時回 cash_exists，什麼都不寫', async () => {
      await register();
      const result = await inA((tx) => registerPaymentAccount(tx, input({ method: 'cash', bankCode: undefined, accountLast4: undefined }), PARTY));
      expect(result).toEqual({ ok: false, error: 'cash_exists' });
      expect(await inA((tx) => listPaymentAccounts(tx))).toHaveLength(2);
    });

    it('持有人的現金收取帳戶停用後，可以再登錄一個', async () => {
      const first = await register();
      await inA((tx) => deactivatePaymentAccount(tx, first.cashAccountId!));
      const again = await inA((tx) => registerPaymentAccount(tx, input({ method: 'cash', name: '重新登錄現金', bankCode: undefined, accountLast4: undefined }), PARTY));
      expect(again).toMatchObject({ ok: true });
    });

    it('持有人是其他人：不帶 party，以姓名識別；同名的其他人共用一個現金收取帳戶', async () => {
      await register({ holderKind: 'other', holderName: '李小華' }, null);
      await register({ holderKind: 'other', holderName: '李小華', accountLast4: '5555' }, null);
      const accounts = await inA((tx) => listPaymentAccounts(tx));
      expect(accounts.every((a) => a.holderPartyId === null)).toBe(true);
      expect(accounts.filter((a) => a.isCash)).toHaveLength(1);
    });

    it('出租人、屋主、代管業者沒有 party 時回 holder_party_required；其他人帶了 party 也不存', async () => {
      const missing = await inA((tx) => registerPaymentAccount(tx, input(), null));
      expect(missing).toEqual({ ok: false, error: 'holder_party_required' });
      await register({ holderKind: 'other', holderName: '李小華' }, PARTY);
      const accounts = await inA((tx) => listPaymentAccounts(tx));
      expect(accounts.every((a) => a.holderPartyId === null)).toBe(true);
    });

    it('寫稽核事件：只放 ID、持有人種類與帳戶性質，不放姓名與銀行識別', async () => {
      const { id, cashAccountId } = await register();
      const events = await auditActions();
      expect(events.map((e) => [e.action, e.object_id])).toEqual([
        ['payment_account.register', id],
        ['payment_account.register', cashAccountId],
      ]);
      expect(events[0].payload).toEqual({ holder_kind: 'lessor', method: 'bank' });
      expect(events[1].payload).toEqual({ holder_kind: 'lessor', method: 'cash' });
      expect(JSON.stringify(events)).not.toMatch(/王大明|0123|812/);
    });
  });

  describe('登錄的持有人檢查（MIL-187）', () => {
    const count = () => inA((tx) => listPaymentAccounts(tx)).then((a) => a.length);

    it('持有人指到不存在的 party：回 holder_not_allowed，什麼都不寫', async () => {
      const result = await inA((tx) => registerPaymentAccount(tx, input({ holderPartyId: newUlid() }), PARTY));
      expect(result).toEqual({ ok: false, error: 'holder_not_allowed' });
      expect(await count()).toBe(0);
    });

    it('持有人指到別的組織的成員：回應與不存在的 party 完全相同', async () => {
      const theirs = await inA((tx) => registerPaymentAccount(tx, input({ holderPartyId: PARTY_B }), PARTY));
      const ghost = await inA((tx) => registerPaymentAccount(tx, input({ holderPartyId: newUlid() }), PARTY));
      expect(theirs).toEqual({ ok: false, error: 'holder_not_allowed' });
      expect(theirs).toEqual(ghost);
      expect(await count()).toBe(0);
    });

    it('持有人格式錯誤的 ID：同樣回 holder_not_allowed', async () => {
      const result = await inA((tx) => registerPaymentAccount(tx, input({ holderPartyId: 'not-a-ulid' }), PARTY));
      expect(result).toEqual({ ok: false, error: 'holder_not_allowed' });
    });

    it('持有人是同組織的其他成員：用請求帶的 party，不用呼叫者', async () => {
      const colleague = await seedOrgMember(withTx, orgA, '同事');
      const { id } = await register({ holderPartyId: colleague });
      expect(await inA((tx) => getPaymentAccount(tx, id))).toMatchObject({ holderPartyId: colleague });
    });

    it('持有人是本組織案件的成員（不是組織成員）也可以', async () => {
      const caseId = testCaseId('HCASEC1');
      await seedCases(withTx, [orgA], [caseId]);
      const tenant = await seedParty(withTx, orgA, '林承租');
      await seedCaseMember(withTx, orgA, caseId, tenant);
      const { id } = await register({ holderPartyId: tenant, holderKind: 'owner' });
      expect(await inA((tx) => getPaymentAccount(tx, id))).toMatchObject({ holderPartyId: tenant, holderKind: 'owner' });
    });

    it('呼叫端傳入的 party 只是沒有指定持有人時的預設值，也要在清單內', async () => {
      const result = await inA((tx) => registerPaymentAccount(tx, input(), newUlid()));
      expect(result).toEqual({ ok: false, error: 'holder_not_allowed' });
    });

    it('持有人是其他人：沒有 party，請求帶不存在的 party 也不影響', async () => {
      const result = await inA((tx) => registerPaymentAccount(tx, input({ holderKind: 'other', holderName: '李小華', holderPartyId: newUlid() }), null));
      expect(result).toMatchObject({ ok: true });
    });
  });

  describe('清單與跨組織', () => {
    it('新的在前，含已停用的帳戶；別的組織看不到', async () => {
      const first = await register({ name: '第一個' });
      const second = await register({ name: '第二個', accountLast4: '2222' });
      await register({ name: 'B 的帳戶' }, PARTY_B, orgB);
      await inA((tx) => deactivatePaymentAccount(tx, first.id));
      const accounts = await inA((tx) => listPaymentAccounts(tx));
      expect(accounts.filter((a) => !a.isCash).map((a) => [a.id, a.active])).toEqual([
        [second.id, true],
        [first.id, false],
      ]);
      expect(accounts.map((a) => a.name)).not.toContain('B 的帳戶');
    });

    it('讀別的組織的帳戶與不存在的帳戶，結果一樣是 null', async () => {
      const { id } = await register({}, PARTY_B, orgB);
      expect(await inA((tx) => getPaymentAccount(tx, id))).toBeNull();
      expect(await inA((tx) => getPaymentAccount(tx, newUlid()))).toBeNull();
    });
  });

  describe('修改', () => {
    it('沒有分錄引用時，持有人與遮罩識別都能改', async () => {
      const { id } = await register();
      const result = await inA((tx) =>
        updatePaymentAccount(tx, id, input({ name: '改名', holderName: '王小明', bankCode: '822', accountLast4: '4444' })),
      );
      expect(result).toEqual({ ok: true });
      expect(await inA((tx) => getPaymentAccount(tx, id))).toMatchObject({
        name: '改名',
        holderName: '王小明',
        bankCode: '822',
        accountLast4: '4444',
        locked: false,
      });
    });

    it('改了持有人，新持有人也有現金收取帳戶', async () => {
      const { id } = await register();
      await inA((tx) => updatePaymentAccount(tx, id, input({ holderKind: 'owner', holderName: '陳屋主' })));
      const cash = (await inA((tx) => listPaymentAccounts(tx))).filter((a) => a.isCash && a.active);
      expect(cash.map((a) => a.holderName).sort()).toEqual(['王大明', '陳屋主']);
    });

    it('有分錄引用後，清單標示 locked；改持有人或遮罩識別回 locked，帳戶不變', async () => {
      const { id } = await register();
      await referenceInLedger(id);
      expect(await inA((tx) => getPaymentAccount(tx, id))).toMatchObject({ locked: true });
      for (const change of [{ holderName: '王小明' }, { holderKind: 'owner' }, { bankCode: '822' }, { accountLast4: '9999' }]) {
        const result = await inA((tx) => updatePaymentAccount(tx, id, input(change)));
        expect(result, JSON.stringify(change)).toEqual({ ok: false, error: 'locked' });
      }
      expect(await inA((tx) => getPaymentAccount(tx, id))).toMatchObject({ holderName: '王大明', bankCode: '812', accountLast4: '0123' });
    });

    it('有分錄引用後，只改名稱仍然可以', async () => {
      const { id } = await register();
      await referenceInLedger(id);
      expect(await inA((tx) => updatePaymentAccount(tx, id, input({ name: '只改名稱' })))).toEqual({ ok: true });
      expect(await inA((tx) => getPaymentAccount(tx, id))).toMatchObject({ name: '只改名稱', locked: true });
    });

    it('別的登入者只改名稱時，持有人的 party 不會被蓋成他自己：有分錄引用的帳戶也不會誤判 locked', async () => {
      const { id } = await register();
      await referenceInLedger(id);
      const other = newUlid();
      expect(await inA((tx) => updatePaymentAccount(tx, id, input({ name: '同事改名' }), other))).toEqual({ ok: true });
      expect(await inA((tx) => getPaymentAccount(tx, id))).toMatchObject({ name: '同事改名', holderPartyId: PARTY, locked: true });
    });

    it('原本是其他人、改成出租人時，用傳入的 party 當持有人', async () => {
      const { id } = await register({ holderKind: 'other', holderName: '李小華' }, null);
      expect(await inA((tx) => updatePaymentAccount(tx, id, input({ holderKind: 'lessor', holderName: '李小華' })))).toEqual({
        ok: false,
        error: 'holder_party_required',
      });
      expect(await inA((tx) => updatePaymentAccount(tx, id, input({ holderKind: 'lessor', holderName: '李小華' }), PARTY))).toEqual({ ok: true });
      expect(await inA((tx) => getPaymentAccount(tx, id))).toMatchObject({ holderKind: 'lessor', holderPartyId: PARTY });
    });

    it('資料庫的觸發器也擋：繞過 repository 直接改持有人會丟錯', async () => {
      const { id } = await register();
      await referenceInLedger(id);
      await expect(inA((tx) => tx.query(`UPDATE org.payment_accounts SET holder_name = '偷改' WHERE id = $1`, [id]))).rejects.toThrow(
        /停用並新增/,
      );
    });

    it('別人的帳戶分錄不影響我的帳戶：別的組織引用同名科目不會鎖住', async () => {
      const { id } = await register();
      await referenceInLedger(id, orgB);
      expect(await inA((tx) => getPaymentAccount(tx, id))).toMatchObject({ locked: false });
      expect(await inA((tx) => updatePaymentAccount(tx, id, input({ holderName: '王小明' })))).toEqual({ ok: true });
    });

    it('找不到、別的組織、已停用的帳戶', async () => {
      const mine = await register();
      const theirs = await register({}, PARTY_B, orgB);
      await inA((tx) => deactivatePaymentAccount(tx, mine.id));
      expect(await inA((tx) => updatePaymentAccount(tx, newUlid(), input()))).toEqual({ ok: false, error: 'not_found' });
      expect(await inA((tx) => updatePaymentAccount(tx, theirs.id, input()))).toEqual({ ok: false, error: 'not_found' });
      expect(await inA((tx) => updatePaymentAccount(tx, mine.id, input()))).toEqual({ ok: false, error: 'inactive' });
    });

    it('不能把銀行帳戶改成現金收取', async () => {
      const { id } = await register();
      const result = await inA((tx) => updatePaymentAccount(tx, id, input({ method: 'cash', bankCode: undefined, accountLast4: undefined })));
      expect(result).toEqual({ ok: false, error: 'method_change' });
    });

    it('改的是現金收取帳戶、新持有人已有現金收取帳戶時回 cash_exists', async () => {
      const first = await register();
      await register({ holderName: '陳屋主', holderKind: 'owner', name: '陳先生' });
      const result = await inA((tx) =>
        updatePaymentAccount(tx, first.cashAccountId!, input({ method: 'cash', holderKind: 'owner', holderName: '陳屋主', bankCode: undefined, accountLast4: undefined })),
      );
      expect(result).toEqual({ ok: false, error: 'cash_exists' });
    });

    it('寫稽核事件 payment_account.update，payload 只列被改的欄位名稱', async () => {
      const { id } = await register();
      await inA((tx) => updatePaymentAccount(tx, id, input({ name: '改名', accountLast4: '4444' })));
      const events = (await auditActions()).filter((e) => e.action === 'payment_account.update');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ changed: ['name', 'account_last4'] });
    });

    it('沒有任何欄位改變時不寫稽核事件', async () => {
      const { id } = await register();
      await inA((tx) => updatePaymentAccount(tx, id, input()));
      expect((await auditActions()).filter((e) => e.action === 'payment_account.update')).toEqual([]);
    });
  });

  describe('修改的持有人檢查（MIL-187）', () => {
    it('改到不存在的 party 或別的組織的成員：回 holder_not_allowed，帳戶不變', async () => {
      const { id } = await register();
      for (const holderPartyId of [newUlid(), PARTY_B, 'not-a-ulid']) {
        const result = await inA((tx) => updatePaymentAccount(tx, id, input({ holderPartyId }), PARTY));
        expect(result, holderPartyId).toEqual({ ok: false, error: 'holder_not_allowed' });
      }
      expect(await inA((tx) => getPaymentAccount(tx, id))).toMatchObject({ holderPartyId: PARTY });
    });

    it('改到同組織的另一位成員：沒有分錄引用時成功，新持有人也有現金收取帳戶', async () => {
      const colleague = await seedOrgMember(withTx, orgA, '同事');
      const { id } = await register();
      expect(await inA((tx) => updatePaymentAccount(tx, id, input({ holderPartyId: colleague, holderName: '同事' })))).toEqual({ ok: true });
      expect(await inA((tx) => getPaymentAccount(tx, id))).toMatchObject({ holderPartyId: colleague });
      const cash = (await inA((tx) => listPaymentAccounts(tx))).filter((a) => a.isCash && a.active);
      expect(cash.map((a) => a.holderPartyId).sort()).toEqual([PARTY, colleague].sort());
    });

    it('有分錄引用後改到另一位成員：回 locked，帳戶不變', async () => {
      const colleague = await seedOrgMember(withTx, orgA, '同事');
      const { id } = await register();
      await referenceInLedger(id);
      expect(await inA((tx) => updatePaymentAccount(tx, id, input({ holderPartyId: colleague })))).toEqual({ ok: false, error: 'locked' });
      expect(await inA((tx) => getPaymentAccount(tx, id))).toMatchObject({ holderPartyId: PARTY });
    });

    it('沿用原持有人時不重新檢查：持有人已不在清單內，仍能改名稱', async () => {
      const leaver = await seedOrgMember(withTx, orgA, '離職者');
      const { id } = await register({ holderPartyId: leaver });
      await referenceInLedger(id);
      await asRole(db, 'app_owner', () =>
        db.query(`DELETE FROM control.org_memberships WHERE user_id IN (SELECT id FROM control.users WHERE party_id = $1)`, [leaver]),
      );
      expect(await inA((tx) => updatePaymentAccount(tx, id, input({ name: '離職後改名' })))).toEqual({ ok: true });
      expect(await inA((tx) => getPaymentAccount(tx, id))).toMatchObject({ name: '離職後改名', holderPartyId: leaver });
    });

    it('改成其他人時 party 清空，不檢查請求帶的 party', async () => {
      const { id } = await register();
      const result = await inA((tx) => updatePaymentAccount(tx, id, input({ holderKind: 'other', holderName: '李小華', holderPartyId: newUlid() })));
      expect(result).toEqual({ ok: true });
      expect(await inA((tx) => getPaymentAccount(tx, id))).toMatchObject({ holderKind: 'other', holderPartyId: null });
    });
  });

  describe('停用', () => {
    it('停用後狀態是已停用，有分錄引用的帳戶也能停用', async () => {
      const { id } = await register();
      await referenceInLedger(id);
      expect(await inA((tx) => deactivatePaymentAccount(tx, id))).toEqual({ ok: true });
      expect(await inA((tx) => getPaymentAccount(tx, id))).toMatchObject({ active: false });
    });

    it('已停用再停用回 already_inactive；找不到與別的組織回 not_found', async () => {
      const { id } = await register();
      const theirs = await register({}, PARTY_B, orgB);
      await inA((tx) => deactivatePaymentAccount(tx, id));
      expect(await inA((tx) => deactivatePaymentAccount(tx, id))).toEqual({ ok: false, error: 'already_inactive' });
      expect(await inA((tx) => deactivatePaymentAccount(tx, newUlid()))).toEqual({ ok: false, error: 'not_found' });
      expect(await inA((tx) => deactivatePaymentAccount(tx, theirs.id))).toEqual({ ok: false, error: 'not_found' });
      expect(await inOrg(orgB, (tx) => getPaymentAccount(tx, theirs.id))).toMatchObject({ active: true });
    });

    it('寫稽核事件 payment_account.deactivate', async () => {
      const { id } = await register();
      await inA((tx) => deactivatePaymentAccount(tx, id));
      const events = (await auditActions()).filter((e) => e.action === 'payment_account.deactivate');
      expect(events.map((e) => e.object_id)).toEqual([id]);
    });

    it('資料庫擋下重新啟用與刪除', async () => {
      const { id } = await register();
      await inA((tx) => deactivatePaymentAccount(tx, id));
      await expect(inA((tx) => tx.query('UPDATE org.payment_accounts SET deactivated_at = NULL WHERE id = $1', [id]))).rejects.toThrow(/重新啟用/);
      await expect(inA((tx) => tx.query('DELETE FROM org.payment_accounts WHERE id = $1', [id]))).rejects.toThrow(/只能停用/);
    });
  });

  describe('資料庫約束', () => {
    it('現金收取帶銀行欄位、銀行帳戶缺銀行欄位、完整帳號都被擋', async () => {
      const insert = (values: string) =>
        inA((tx) =>
          tx.query(
            `INSERT INTO org.payment_accounts (id, org_id, name, holder_kind, holder_name, account_kind, bank_code, account_last4)
             VALUES ($1, $2, 'x', 'other', 'y', ${values})`,
            [newUlid(), orgA],
          ),
        );
      await expect(insert(`'cash', '812', '0123'`)).rejects.toThrow(/check constraint/);
      await expect(insert(`'general', NULL, NULL`)).rejects.toThrow(/check constraint/);
      await expect(insert(`'general', '812', '12345678'`)).rejects.toThrow(/check constraint/);
      await expect(insert(`'trust', NULL, NULL`)).rejects.toThrow(/check constraint/);
    });

    it('持有人是其他人卻帶 party，或不是其他人卻沒有 party，被擋', async () => {
      const insert = (kind: string, party: string | null) =>
        inA((tx) =>
          tx.query(
            `INSERT INTO org.payment_accounts (id, org_id, name, holder_kind, holder_party_id, holder_name, account_kind)
             VALUES ($1, $2, 'x', $3, $4, 'y', 'cash')`,
            [newUlid(), orgA, kind, party],
          ),
        );
      await expect(insert('other', PARTY)).rejects.toThrow(/check constraint/);
      await expect(insert('lessor', null)).rejects.toThrow(/check constraint/);
    });
  });

  describe('assertPaymentAccountsInOrg', () => {
    it('全部屬於本組織且啟用時回 ok', async () => {
      const a = await register();
      const b = await register({ accountLast4: '2222' });
      expect(await inA((tx) => assertPaymentAccountsInOrg(tx, [a.id, b.id, a.id]))).toEqual({ ok: true });
    });

    it('別的組織與不存在的帳戶一律算 notFound，不洩漏它屬於誰', async () => {
      const mine = await register();
      const theirs = await register({}, PARTY_B, orgB);
      const ghost = newUlid();
      expect(await inA((tx) => assertPaymentAccountsInOrg(tx, [mine.id, theirs.id, ghost]))).toEqual({
        ok: false,
        notFound: [theirs.id, ghost],
        inactive: [],
      });
    });

    it('已停用的帳戶預設不通過，allowInactive 時放行（沖銷舊分錄用）', async () => {
      const { id } = await register();
      await inA((tx) => deactivatePaymentAccount(tx, id));
      expect(await inA((tx) => assertPaymentAccountsInOrg(tx, [id]))).toEqual({ ok: false, notFound: [], inactive: [id] });
      expect(await inA((tx) => assertPaymentAccountsInOrg(tx, [id], { allowInactive: true }))).toEqual({ ok: true });
    });

    it('傳入鏡像帳科目編碼以外的東西：空陣列回 ok，不是 ULID 的 ID 算 notFound', async () => {
      expect(await inA((tx) => assertPaymentAccountsInOrg(tx, []))).toEqual({ ok: true });
      expect(await inA((tx) => assertPaymentAccountsInOrg(tx, ['not-a-ulid']))).toEqual({
        ok: false,
        notFound: ['not-a-ulid'],
        inactive: [],
      });
    });
  });
});
