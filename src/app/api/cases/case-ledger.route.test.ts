import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openCaseLedger } from '@/lib/case-ledger';
import { findOrCreateParty, insertCaseMember } from '@/lib/case-store';
import { setMailer, type MailMessage, type Mailer } from '@/lib/mailer';
import { withTx } from '@/lib/pg/database';
import { actAs, actAsContext, setupRouteDb, TEST_PARTY_ID, TEST_USER_ID, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import type { OrgRole } from '@/lib/request-context';
import { PUT as putDefaultAccounts } from './[id]/default-accounts/route';
import { GET as getLedger } from './[id]/ledger/route';
import { DELETE as deleteRemitter } from './[id]/remitter-ids/[remitterId]/route';
import { POST as postRemitter } from './[id]/remitter-ids/route';
import { PUT as putSocialHousing } from './[id]/social-housing/route';

// 接上案件的 route（MIL-123）：帳務設定讀取、社宅旗標、匯款識別、預設收款帳戶。
// 接縫是 route handler 的 response。連線是 PGlite 的 app_rw，RLS 與 authorize() 都生效。

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
});
afterEach(() => setMailer(undefined));

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const ctxWithRemitter = (id: string, remitterId: string) => ({ params: Promise.resolve({ id, remitterId }) });
const req = (method: string, payload?: unknown) =>
  new NextRequest('http://localhost/api/x', { method, body: payload === undefined ? undefined : JSON.stringify(payload) });
const snap = async (res: Response) => ({ status: res.status, body: await res.text() });
const NOT_FOUND = { status: 404, body: JSON.stringify({ error: '案件不存在' }) };
const PAST = new Date('2026-01-01T00:00:00.000Z');

async function insertCase(orgId: string, businessType = 'managed', over: { socialHousing?: boolean; linked?: string; kind?: 'lease' | 'management' } = {}): Promise<string> {
  const caseId = newUlid();
  await withTx({ kind: 'org', orgId }, async (tx) => {
    await tx.query(
      over.kind === 'management'
        ? `INSERT INTO org.cases (id, org_id, kind, state, title, social_housing) VALUES ($1, $2, 'management', 'active', '委託管理案件', $3)`
        : `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, social_housing, linked_mandate_case_id)
           VALUES ($1, $2, 'lease', 'active', $4, '板橋區某某路 3 樓', $3, $5)`,
      over.kind === 'management' ? [caseId, orgId, over.socialHousing ?? false] : [caseId, orgId, over.socialHousing ?? false, businessType, over.linked ?? null],
    );
    await tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'route-test@example.com', '測試帳號') ON CONFLICT DO NOTHING`, [TEST_PARTY_ID]);
  });
  return caseId;
}

const addMemberRow = (orgId: string, caseId: string, relation: 'lessor' | 'lessee' | 'mandator', email: string, name: string) =>
  withTx({ kind: 'org', orgId }, async (tx) => {
    const partyId = await findOrCreateParty(tx, email, name);
    await insertCaseMember(tx, caseId, { partyId, relation }, PAST);
    return partyId;
  });

const asOrg = (orgId: string, partyId: string, role: OrgRole = 'admin') =>
  actAsContext({ kind: 'org', orgId, orgKind: 'owner', userId: TEST_USER_ID, partyId, role, requestId: 't' });

async function newAccount(orgId: string, name = '業者帳戶'): Promise<string> {
  const id = newUlid();
  await withTx({ kind: 'org', orgId }, (tx) =>
    tx.query(
      `INSERT INTO org.payment_accounts (id, org_id, name, holder_kind, holder_name, account_kind) VALUES ($1, $2, $3, 'other', $3, 'cash')`,
      [id, orgId, name],
    ),
  );
  return id;
}

describe('GET /api/cases/[id]/ledger', () => {
  it('主辦組織：押金台帳、餘額、期別、匯款識別、預設帳戶、旗標紀錄與衝突都在回應裡', async () => {
    const id = await insertCase(kit.orgA);
    await withTx({ kind: 'org', orgId: kit.orgA }, (tx) =>
      openCaseLedger(tx, id, { deposit: 60000, startDate: '2026-11-01', endDate: '2027-01-31', payDay: 5, rent: 30000 }),
    );
    await postRemitter(req('POST', { kind: 'payer_name', value: '王大明' }), ctx(id));
    const res = await getLedger(req('GET'), ctx(id));
    expect(res.status).toBe(200);
    const data = (await json(res)).data;
    expect(data).toMatchObject({
      socialHousing: false,
      depositLedger: { caseId: id, expectedAmount: 60000, status: 'open' },
      depositBalance: 0,
      defaultAccounts: { rentAccountId: null, depositAccountId: null },
      socialHousingChanges: [],
      holderConflicts: [],
    });
    expect(data.periods.map((p: { periodKey: string; amount: number }) => [p.periodKey, p.amount])).toEqual([
      ['2026-11', 30000],
      ['2026-12', 30000],
      ['2027-01', 30000],
    ]);
    expect(data.remitterIds).toEqual([expect.objectContaining({ kind: 'payer_name', value: '王大明' })]);
  });

  it('合約還沒全員完成：台帳是 null，期別是空陣列', async () => {
    const id = await insertCase(kit.orgA);
    const data = (await json(await getLedger(req('GET'), ctx(id)))).data;
    expect(data).toMatchObject({ depositLedger: null, depositBalance: 0, periods: [] });
  });

  it('viewer 讀得到；出租人（屋主，別的組織）讀得到；承租人與其他組織讀不到，回應與不存在相同', async () => {
    const id = await insertCase(kit.orgA);
    const lessor = await addMemberRow(kit.orgA, id, 'lessor', 'owner@example.com', '陳屋主');
    const lessee = await addMemberRow(kit.orgA, id, 'lessee', 'tenant@example.com', '王租客');

    asOrg(kit.orgA, TEST_PARTY_ID, 'viewer');
    expect((await getLedger(req('GET'), ctx(id))).status).toBe(200);
    asOrg(kit.orgB, lessor);
    expect((await getLedger(req('GET'), ctx(id))).status).toBe(200);
    asOrg(kit.orgB, lessee);
    expect(await snap(await getLedger(req('GET'), ctx(id)))).toEqual(NOT_FOUND);
    asOrg(kit.orgB, TEST_PARTY_ID);
    expect(await snap(await getLedger(req('GET'), ctx(id)))).toEqual(NOT_FOUND);
    expect(await snap(await getLedger(req('GET'), ctx(newUlid())))).toEqual(NOT_FOUND);
    expect(await snap(await getLedger(req('GET'), ctx('not-a-ulid')))).toEqual(NOT_FOUND);
  });

  it('委託管理案件沒有帳務設定：回 404', async () => {
    const id = await insertCase(kit.orgA, 'managed', { kind: 'management' });
    expect(await snap(await getLedger(req('GET'), ctx(id)))).toEqual(NOT_FOUND);
  });
});

describe('PUT /api/cases/[id]/social-housing', () => {
  it('改為社宅：回傳新旗標，GET 看得到修改紀錄', async () => {
    const id = await insertCase(kit.orgA);
    const res = await putSocialHousing(req('PUT', { value: true, reason: '政府公告為社宅計畫' }), ctx(id));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ socialHousing: true, mandatorNotified: false, holderConflicts: [] });
    const data = (await json(await getLedger(req('GET'), ctx(id)))).data;
    expect(data.socialHousing).toBe(true);
    expect(data.socialHousingChanges).toEqual([
      expect.objectContaining({ fromValue: false, toValue: true, reason: '政府公告為社宅計畫', changedByPartyId: TEST_PARTY_ID }),
    ]);
  });

  it('有委託人：交易提交後才派送 email，寄件名義是主辦組織', async () => {
    const sent: MailMessage[] = [];
    const mailer: Mailer = {
      send: async (message) => {
        sent.push(message);
        return { id: 'mail-1' };
      },
      listSent: async () => [],
    };
    setMailer(mailer);
    const mandateCase = await insertCase(kit.orgA, 'managed', { kind: 'management' });
    await addMemberRow(kit.orgA, mandateCase, 'mandator', 'mandator@example.com', '王屋主');
    const id = await insertCase(kit.orgA, 'managed', { linked: mandateCase });

    const res = await putSocialHousing(req('PUT', { value: true, reason: '標錯了' }), ctx(id));
    expect(res.status).toBe(200);
    expect((await json(res)).data.mandatorNotified).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'mandator@example.com', from: 'A 組織', kind: 'case.social_housing_changed' });
    expect(sent[0].text).toContain('標錯了');
  });

  it('寄信失敗：已提交的修改不回滾，回應仍是 200', async () => {
    setMailer({
      send: async () => {
        throw new Error('寄信服務暫時不可用');
      },
      listSent: async () => [],
    });
    const mandateCase = await insertCase(kit.orgA, 'managed', { kind: 'management' });
    await addMemberRow(kit.orgA, mandateCase, 'mandator', 'mandator@example.com', '王屋主');
    const id = await insertCase(kit.orgA, 'managed', { linked: mandateCase });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await putSocialHousing(req('PUT', { value: true, reason: '標錯了' }), ctx(id))).status).toBe(200);
    quiet.mockRestore();
    expect((await json(await getLedger(req('GET'), ctx(id)))).data.socialHousing).toBe(true);
  });

  it.each([
    ['沒有指定旗標', { reason: '原因' }, 400, '請指定社宅代管旗標要改成是或否'],
    ['旗標不是布林', { value: 'yes', reason: '原因' }, 400, '請指定社宅代管旗標要改成是或否'],
    ['沒有原因', { value: true }, 400, '請填寫修改原因'],
    ['原因只有空白', { value: true, reason: '  ' }, 400, '請填寫修改原因'],
    ['原因太長', { value: true, reason: '字'.repeat(501) }, 400, '修改原因不得超過 500 字'],
  ])('%s：回 400，旗標不變', async (_name, body, status, message) => {
    const id = await insertCase(kit.orgA);
    const res = await putSocialHousing(req('PUT', body), ctx(id));
    expect(res.status).toBe(status);
    expect((await json(res)).error).toBe(message);
    expect((await json(await getLedger(req('GET'), ctx(id)))).data.socialHousing).toBe(false);
  });

  it('旗標已經是這個值：409', async () => {
    const id = await insertCase(kit.orgA, 'managed', { socialHousing: true });
    const res = await putSocialHousing(req('PUT', { value: true, reason: '重複' }), ctx(id));
    expect(res.status).toBe(409);
    expect((await json(res)).error).toContain('已經是');
  });

  it('自管案件不適用：被權限擋下，回應與不存在相同', async () => {
    const id = await insertCase(kit.orgA, 'self_managed');
    expect(await snap(await putSocialHousing(req('PUT', { value: true, reason: '嘗試' }), ctx(id)))).toEqual(NOT_FOUND);
  });

  it('viewer、別的組織、屋主本人、承租人都被擋下，回應與不存在相同，旗標不變', async () => {
    const id = await insertCase(kit.orgA);
    const lessor = await addMemberRow(kit.orgA, id, 'lessor', 'owner@example.com', '陳屋主');
    const lessee = await addMemberRow(kit.orgA, id, 'lessee', 'tenant@example.com', '王租客');
    const body = { value: true, reason: '嘗試' };

    asOrg(kit.orgA, TEST_PARTY_ID, 'viewer');
    expect(await snap(await putSocialHousing(req('PUT', body), ctx(id)))).toEqual(NOT_FOUND);
    asOrg(kit.orgB, TEST_PARTY_ID);
    expect(await snap(await putSocialHousing(req('PUT', body), ctx(id)))).toEqual(NOT_FOUND);
    asOrg(kit.orgB, lessor);
    expect(await snap(await putSocialHousing(req('PUT', body), ctx(id)))).toEqual(NOT_FOUND);
    asOrg(kit.orgB, lessee);
    expect(await snap(await putSocialHousing(req('PUT', body), ctx(id)))).toEqual(NOT_FOUND);
    expect(await snap(await putSocialHousing(req('PUT', body), ctx(newUlid())))).toEqual(NOT_FOUND);

    actAs(kit.orgA);
    expect((await json(await getLedger(req('GET'), ctx(id)))).data.socialHousing).toBe(false);
  });
});

describe('匯款識別 route', () => {
  it('登錄、重複、列出、移除', async () => {
    const id = await insertCase(kit.orgA);
    const created = await postRemitter(req('POST', { kind: 'account_last5', value: '１２３４５' }), ctx(id));
    expect(created.status).toBe(201);
    const remitterId = (await json(created)).data.id;

    const duplicate = await postRemitter(req('POST', { kind: 'account_last5', value: '12345' }), ctx(id));
    expect(duplicate.status).toBe(409);

    const listed = (await json(await getLedger(req('GET'), ctx(id)))).data.remitterIds;
    expect(listed).toEqual([expect.objectContaining({ id: remitterId, kind: 'account_last5', value: '12345' })]);

    expect((await deleteRemitter(req('DELETE'), ctxWithRemitter(id, remitterId))).status).toBe(200);
    expect((await deleteRemitter(req('DELETE'), ctxWithRemitter(id, remitterId))).status).toBe(404);
    expect((await json(await getLedger(req('GET'), ctx(id)))).data.remitterIds).toEqual([]);
  });

  it('輸入不合格回 400 與訊息', async () => {
    const id = await insertCase(kit.orgA);
    const res = await postRemitter(req('POST', { kind: 'account_last5', value: '12' }), ctx(id));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('5 位數字');
  });

  it('viewer 與別的組織被擋下；別的組織的識別移不掉', async () => {
    const id = await insertCase(kit.orgA);
    const remitterId = (await json(await postRemitter(req('POST', { kind: 'payer_name', value: '王大明' }), ctx(id)))).data.id;

    asOrg(kit.orgA, TEST_PARTY_ID, 'viewer');
    expect(await snap(await postRemitter(req('POST', { kind: 'payer_name', value: '李小華' }), ctx(id)))).toEqual(NOT_FOUND);
    expect(await snap(await deleteRemitter(req('DELETE'), ctxWithRemitter(id, remitterId)))).toEqual(NOT_FOUND);
    asOrg(kit.orgB, TEST_PARTY_ID);
    expect(await snap(await postRemitter(req('POST', { kind: 'payer_name', value: '李小華' }), ctx(id)))).toEqual(NOT_FOUND);
    expect(await snap(await deleteRemitter(req('DELETE'), ctxWithRemitter(id, remitterId)))).toEqual(NOT_FOUND);

    actAs(kit.orgA);
    expect((await json(await getLedger(req('GET'), ctx(id)))).data.remitterIds).toHaveLength(1);
  });

  it('移除時 ID 格式錯誤或屬於別的案件：404', async () => {
    const id = await insertCase(kit.orgA);
    const other = await insertCase(kit.orgA);
    const remitterId = (await json(await postRemitter(req('POST', { kind: 'payer_name', value: '王大明' }), ctx(id)))).data.id;
    expect((await deleteRemitter(req('DELETE'), ctxWithRemitter(id, 'xxx'))).status).toBe(404);
    expect((await deleteRemitter(req('DELETE'), ctxWithRemitter(other, remitterId))).status).toBe(404);
  });
});

describe('PUT /api/cases/[id]/default-accounts', () => {
  it('設定、清除、局部更新', async () => {
    const id = await insertCase(kit.orgA);
    const rent = await newAccount(kit.orgA, '租金帳戶');
    const deposit = await newAccount(kit.orgA, '押金帳戶');
    expect((await putDefaultAccounts(req('PUT', { rentAccountId: rent, depositAccountId: deposit }), ctx(id))).status).toBe(200);
    expect((await json(await getLedger(req('GET'), ctx(id)))).data.defaultAccounts).toEqual({ rentAccountId: rent, depositAccountId: deposit });
    expect((await putDefaultAccounts(req('PUT', { rentAccountId: null }), ctx(id))).status).toBe(200);
    expect((await json(await getLedger(req('GET'), ctx(id)))).data.defaultAccounts).toEqual({ rentAccountId: null, depositAccountId: deposit });
  });

  it('別的組織的帳戶、不存在的帳戶：400，訊息相同；欄位型別錯：400', async () => {
    const id = await insertCase(kit.orgA);
    const theirs = await newAccount(kit.orgB);
    const a = await putDefaultAccounts(req('PUT', { rentAccountId: theirs }), ctx(id));
    const b = await putDefaultAccounts(req('PUT', { rentAccountId: newUlid() }), ctx(id));
    expect(a.status).toBe(400);
    expect(await snap(a)).toEqual(await snap(b));
    expect((await putDefaultAccounts(req('PUT', { rentAccountId: 123 }), ctx(id))).status).toBe(400);
  });

  it('viewer 與別的組織被擋下', async () => {
    const id = await insertCase(kit.orgA);
    asOrg(kit.orgA, TEST_PARTY_ID, 'viewer');
    expect(await snap(await putDefaultAccounts(req('PUT', { rentAccountId: null }), ctx(id)))).toEqual(NOT_FOUND);
    asOrg(kit.orgB, TEST_PARTY_ID);
    expect(await snap(await putDefaultAccounts(req('PUT', { rentAccountId: null }), ctx(id)))).toEqual(NOT_FOUND);
  });
});
