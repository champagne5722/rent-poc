import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openCaseLedger } from '@/lib/case-ledger';
import { findOrCreateParty, insertCaseMember } from '@/lib/case-store';
import { setMailer } from '@/lib/mailer';
import { withTx } from '@/lib/pg/database';
import { actAs, actAsContext, setupRouteDb, TEST_PARTY_ID, TEST_USER_ID, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import type { OrgRole } from '@/lib/request-context';
import { GET as getLedger } from './[id]/ledger/route';
import { POST as postReceipt } from './[id]/receipts/route';

// 手動登錄入帳確認的 route（MIL-125）。接縫是 route handler 的 response body。
// 連線是 PGlite 的 app_rw，RLS 與 authorize() 都生效。證明檔寫進記憶體版的 FileStore。

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// 證明檔改寫進記憶體，測試不留檔案，也能檢查失敗與重送時有沒有刪掉剛寫的檔案
const stored = new Map<string, Uint8Array>();
vi.mock('@/lib/file-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/file-store')>()),
  getFileStore: () => ({
    write: async (key: string, bytes: Uint8Array) => {
      stored.set(key, bytes);
      return { sha256: '', byteSize: bytes.byteLength };
    },
    read: async (key: string) => stored.get(key) ?? null,
    exists: async (key: string) => stored.has(key),
    delete: async (key: string) => {
      stored.delete(key);
    },
  }),
}));

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
  stored.clear();
});
afterEach(() => setMailer(undefined));

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonReq = (payload: unknown) =>
  new NextRequest('http://localhost/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const getReq = () => new NextRequest('http://localhost/api/x', { method: 'GET' });
const snap = async (res: Response) => ({ status: res.status, body: await res.text() });
const NOT_FOUND = { status: 404, body: JSON.stringify({ error: '案件不存在' }) };
const PAST = new Date('2026-01-01T00:00:00.000Z');
const TERMS = { deposit: 60000, startDate: '2026-11-01', endDate: '2027-01-31', payDay: 5, rent: 30000 };

async function insertCase(orgId: string, over: { businessType?: string; open?: boolean } = {}): Promise<string> {
  const caseId = newUlid();
  await withTx({ kind: 'org', orgId }, async (tx) => {
    await tx.query(
      `INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', 'active', $3, '板橋區某某路 3 樓')`,
      [caseId, orgId, over.businessType ?? 'self_managed'],
    );
    await tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'route-test@example.com', '測試帳號') ON CONFLICT DO NOTHING`, [TEST_PARTY_ID]);
    if (over.open !== false) await openCaseLedger(tx, caseId, TERMS);
  });
  return caseId;
}

async function newAccount(orgId: string, kind: 'cash' | 'general' = 'general'): Promise<string> {
  const id = newUlid();
  await withTx({ kind: 'org', orgId }, (tx) =>
    tx.query(
      kind === 'cash'
        ? `INSERT INTO org.payment_accounts (id, org_id, name, holder_kind, holder_name, account_kind) VALUES ($1, $2, '現金', 'other', $3, 'cash')`
        : `INSERT INTO org.payment_accounts (id, org_id, name, holder_kind, holder_name, account_kind, bank_code, account_last4)
           VALUES ($1, $2, '王先生的帳戶', 'other', $3, 'general', '812', '0123')`,
      [id, orgId, `持有人${id}`],
    ),
  );
  return id;
}

const body = (accountId: string, over: Record<string, unknown> = {}) => ({
  idempotencyKey: `form-${newUlid()}`,
  purpose: 'rent',
  amount: 30000,
  valueDate: '2026-11-08',
  paymentAccountId: accountId,
  ...over,
});

const asOrg = (orgId: string, partyId: string, role: OrgRole = 'admin') =>
  actAsContext({ kind: 'org', orgId, orgKind: 'owner', userId: TEST_USER_ID, partyId, role, requestId: 't' });

const addMemberRow = (orgId: string, caseId: string, relation: 'lessor' | 'lessee', email: string, name: string) =>
  withTx({ kind: 'org', orgId }, async (tx) => {
    const partyId = await findOrCreateParty(tx, email, name);
    await insertCaseMember(tx, caseId, { partyId, relation }, PAST);
    return partyId;
  });

describe('POST /api/cases/[id]/receipts', () => {
  it('登錄一筆租金：201，回應有入帳確認、配置、預收與冪等旗標；GET 看到期別已入帳', async () => {
    const caseId = await insertCase(kit.orgA);
    const account = await newAccount(kit.orgA);
    const res = await postReceipt(jsonReq(body(account)), ctx(caseId));
    expect(res.status).toBe(201);
    const data = (await json(res)).data;
    expect(data).toMatchObject({
      duplicate: false,
      prepaid: 0,
      holderAcknowledgmentId: null,
      evidenceReused: false,
      confirmation: { caseId, purpose: 'rent', amount: 30000, valueDate: '2026-11-08', source: 'manual', paymentAccountId: account, hasEvidence: false, recordedByPartyId: TEST_PARTY_ID },
    });
    expect(data.allocations).toEqual([{ periodId: expect.any(String), periodKey: '2026-11', amount: 30000 }]);

    const ledger = (await json(await getLedger(getReq(), ctx(caseId)))).data;
    expect(ledger.canRecordPayment).toBe(true);
    expect(ledger.periods.map((p: { periodKey: string; status: string; outstanding: number }) => [p.periodKey, p.status, p.outstanding])).toEqual([
      ['2026-11', 'paid', 0],
      ['2026-12', 'unpaid', 30000],
      ['2027-01', 'unpaid', 30000],
    ]);
    expect(ledger.receipts).toEqual([expect.objectContaining({ purpose: 'rent', amount: 30000, accountName: '王先生的帳戶', isCash: false, reversed: false, holderAcknowledged: false })]);
  });

  it('部分入帳：期別是部分入帳並顯示差額', async () => {
    const caseId = await insertCase(kit.orgA);
    const account = await newAccount(kit.orgA);
    await postReceipt(jsonReq(body(account, { amount: 12000 })), ctx(caseId));
    const ledger = (await json(await getLedger(getReq(), ctx(caseId)))).data;
    expect(ledger.periods[0]).toMatchObject({ periodKey: '2026-11', status: 'partial', allocated: 12000, outstanding: 18000 });
  });

  it('超額變預收租金：回應與 GET 都有預收金額', async () => {
    const caseId = await insertCase(kit.orgA);
    const account = await newAccount(kit.orgA);
    const res = await postReceipt(jsonReq(body(account, { amount: 100000 })), ctx(caseId));
    expect((await json(res)).data).toMatchObject({ prepaid: 10000 });
    expect((await json(await getLedger(getReq(), ctx(caseId)))).data).toMatchObject({ prepaidBalance: 10000 });
  });

  it('押金：不配置期別，GET 的累計已收與押金餘額都更新；現金收取帳戶標示現金收取', async () => {
    const caseId = await insertCase(kit.orgA);
    const cash = await newAccount(kit.orgA, 'cash');
    const res = await postReceipt(jsonReq(body(cash, { purpose: 'security_deposit', amount: 40000 })), ctx(caseId));
    expect(res.status).toBe(201);
    expect((await json(res)).data).toMatchObject({ allocations: [], prepaid: 0 });
    const ledger = (await json(await getLedger(getReq(), ctx(caseId)))).data;
    expect(ledger).toMatchObject({ depositCollected: 40000, depositBalance: 40000 });
    expect(ledger.depositLedger.expectedAmount).toBe(60000);
    expect(ledger.receipts[0]).toMatchObject({ purpose: 'security_deposit', isCash: true });
  });

  it('連點兩次（同一個冪等鍵）：第一次 201，第二次 200 回原本那筆，只入帳一次', async () => {
    const caseId = await insertCase(kit.orgA);
    const account = await newAccount(kit.orgA);
    const payload = body(account);
    const first = await json(await postReceipt(jsonReq(payload), ctx(caseId)));
    const secondRes = await postReceipt(jsonReq(payload), ctx(caseId));
    expect(secondRes.status).toBe(200);
    const second = await json(secondRes);
    expect(second.data).toMatchObject({ duplicate: true, confirmation: { id: first.data.confirmation.id } });
    const ledger = (await json(await getLedger(getReq(), ctx(caseId)))).data;
    expect(ledger.receipts).toHaveLength(1);
    expect(ledger.periods[0]).toMatchObject({ allocated: 30000, status: 'paid' });
  });

  it('同一個冪等鍵但內容不同：409', async () => {
    const caseId = await insertCase(kit.orgA);
    const account = await newAccount(kit.orgA);
    const payload = body(account);
    await postReceipt(jsonReq(payload), ctx(caseId));
    const res = await postReceipt(jsonReq({ ...payload, amount: 31000 }), ctx(caseId));
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'idempotency_conflict' });
  });

  it('合約尚未完成：409，什麼都不寫', async () => {
    const caseId = await insertCase(kit.orgA, { open: false });
    const account = await newAccount(kit.orgA);
    const res = await postReceipt(jsonReq(body(account)), ctx(caseId));
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: '合約尚未全員簽署完成，還不能登錄入帳', code: 'ledger_not_open' });
  });

  it('收款帳戶屬於別的組織：422，回應與不存在的帳戶相同', async () => {
    const caseId = await insertCase(kit.orgA);
    const other = await newAccount(kit.orgB);
    const a = await snap(await postReceipt(jsonReq(body(other)), ctx(caseId)));
    const b = await snap(await postReceipt(jsonReq(body(newUlid())), ctx(caseId)));
    expect(a).toEqual(b);
    expect(a.status).toBe(422);
    expect(JSON.parse(a.body)).toEqual({ error: '收款帳戶不存在或已停用', code: 'account_not_usable' });
  });

  it.each([
    ['金額 0', { amount: 0 }, '入帳金額必須是大於 0 的整數元'],
    ['入帳日不存在', { valueDate: '2026-02-30' }, '入帳日必須是存在的日期（YYYY-MM-DD）'],
    ['沒選用途', { purpose: 'deposit' }, '請選擇入帳用途：租金或押金'],
  ])('欄位檢查：%s 回 400，先於權限檢查', async (_label, over, error) => {
    const caseId = await insertCase(kit.orgA);
    const account = await newAccount(kit.orgA);
    expect(await snap(await postReceipt(jsonReq(body(account, over)), ctx(caseId)))).toEqual({ status: 400, body: JSON.stringify({ error }) });
  });

  describe('誰能登錄', () => {
    it('viewer、承租人、別的組織與不存在的案件：回應都與案件不存在逐位元相同', async () => {
      const caseId = await insertCase(kit.orgA);
      const account = await newAccount(kit.orgA);
      const lessee = await addMemberRow(kit.orgA, caseId, 'lessee', 'tenant@example.com', '王租客');

      asOrg(kit.orgA, TEST_PARTY_ID, 'viewer');
      expect(await snap(await postReceipt(jsonReq(body(account)), ctx(caseId)))).toEqual(NOT_FOUND);
      asOrg(kit.orgB, lessee);
      expect(await snap(await postReceipt(jsonReq(body(account)), ctx(caseId)))).toEqual(NOT_FOUND);
      asOrg(kit.orgB, TEST_PARTY_ID);
      expect(await snap(await postReceipt(jsonReq(body(account)), ctx(caseId)))).toEqual(NOT_FOUND);
      actAs(kit.orgA);
      expect(await snap(await postReceipt(jsonReq(body(account)), ctx(newUlid())))).toEqual(NOT_FOUND);
      expect(await snap(await postReceipt(jsonReq(body(account)), ctx('not-a-ulid')))).toEqual(NOT_FOUND);

      // 全部被拒之後，什麼都沒寫
      const ledger = (await json(await getLedger(getReq(), ctx(caseId)))).data;
      expect(ledger.receipts).toEqual([]);
    });

    it('staff 可以登錄', async () => {
      const caseId = await insertCase(kit.orgA);
      const account = await newAccount(kit.orgA);
      asOrg(kit.orgA, TEST_PARTY_ID, 'staff');
      expect((await postReceipt(jsonReq(body(account)), ctx(caseId))).status).toBe(201);
    });

    it('別的組織的案件成員（出租人）通過動作表也不能登錄：回應與案件不存在相同', async () => {
      const caseId = await insertCase(kit.orgA);
      const account = await newAccount(kit.orgA);
      const lessor = await addMemberRow(kit.orgA, caseId, 'lessor', 'owner@example.com', '陳屋主');
      asOrg(kit.orgB, lessor);
      expect(await snap(await postReceipt(jsonReq(body(account)), ctx(caseId)))).toEqual(NOT_FOUND);
    });

    it('代管案件：委託事實尚未載入，一律拒絕，回應與案件不存在相同', async () => {
      const caseId = await insertCase(kit.orgA, { businessType: 'managed' });
      const account = await newAccount(kit.orgA);
      expect(await snap(await postReceipt(jsonReq(body(account)), ctx(caseId)))).toEqual(NOT_FOUND);
    });
  });

  describe('證明檔', () => {
    const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a])], '匯款單.pdf', { type: 'application/pdf' });
    const formReq = (fields: Record<string, string>, file?: File) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      if (file) form.set('evidence', file);
      return new NextRequest('http://localhost/api/x', { method: 'POST', body: form });
    };
    const fields = (accountId: string, over: Record<string, string> = {}) => ({
      idempotencyKey: `form-${newUlid()}`,
      purpose: 'rent',
      amount: '30000',
      valueDate: '2026-11-08',
      paymentAccountId: accountId,
      ...over,
    });

    it('multipart 不附證明檔也能登錄', async () => {
      const caseId = await insertCase(kit.orgA);
      const account = await newAccount(kit.orgA);
      const res = await postReceipt(formReq(fields(account)), ctx(caseId));
      expect(res.status).toBe(201);
      expect((await json(res)).data.confirmation).toMatchObject({ amount: 30000, hasEvidence: false });
    });

    it('附證明檔：記下有證明檔；同一份檔案再用時警告，不阻擋', async () => {
      const caseId = await insertCase(kit.orgA);
      const account = await newAccount(kit.orgA);
      const first = await postReceipt(formReq(fields(account), pdf()), ctx(caseId));
      expect(first.status).toBe(201);
      expect((await json(first)).data).toMatchObject({ evidenceReused: false, confirmation: { hasEvidence: true } });
      const second = await postReceipt(formReq(fields(account), pdf()), ctx(caseId));
      expect(second.status).toBe(201);
      const secondData = (await json(second)).data;
      expect(secondData).toMatchObject({ evidenceReused: true, confirmation: { hasEvidence: true } });
      expect(secondData.confirmation.evidenceReuseOf).toEqual(expect.any(String));
    });

    it('附證明檔成功時檔案留在 FileStore；重送同一個冪等鍵、入帳失敗與沒有權限時，剛寫的檔案刪掉', async () => {
      const caseId = await insertCase(kit.orgA);
      const account = await newAccount(kit.orgA);
      const payload = fields(account);
      expect((await postReceipt(formReq(payload, pdf()), ctx(caseId))).status).toBe(201);
      expect(stored.size).toBe(1);
      const [key] = [...stored.keys()];
      expect(key).toMatch(new RegExp(`^org/${kit.orgA}/ledger/receipt-evidence/[0-9A-Z]{26}\\.pdf$`));

      expect((await postReceipt(formReq(payload, pdf()), ctx(caseId))).status).toBe(200); // 重送
      expect(stored.size).toBe(1);
      expect((await postReceipt(formReq(fields(newUlid()), pdf()), ctx(caseId))).status).toBe(422); // 帳戶不存在
      expect(stored.size).toBe(1);

      asOrg(kit.orgA, TEST_PARTY_ID, 'viewer');
      expect((await postReceipt(formReq(fields(account), pdf()), ctx(caseId))).status).toBe(404); // 沒有權限，不寫檔
      expect(stored.size).toBe(1);
      expect([...stored.keys()]).toEqual([key]);
    });

    it('證明檔不是 PDF、JPEG、PNG：400；超過 5 MB：413；都不入帳', async () => {
      const caseId = await insertCase(kit.orgA);
      const account = await newAccount(kit.orgA);
      const text = new File(['<html></html>'], 'x.pdf', { type: 'application/pdf' });
      const badType = await postReceipt(formReq(fields(account), text), ctx(caseId));
      expect(badType.status).toBe(400);
      expect(await json(badType)).toEqual({ error: '證明檔只收 PDF、JPEG 與 PNG' });
      const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' });
      expect((await postReceipt(formReq(fields(account), big), ctx(caseId))).status).toBe(413);
      expect((await json(await getLedger(getReq(), ctx(caseId)))).data.receipts).toEqual([]);
    });
  });
});
