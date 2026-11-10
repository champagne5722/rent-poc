import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTx } from '@/lib/pg/database';
import { actAs, actAsContext, actAsError, setupRouteDb, TEST_PARTY_ID, TEST_USER_ID, type RouteDb } from '@/lib/pg/route-test-kit';
import { isUlid, newUlid } from '@/lib/pg/ulid';
import { Unauthenticated } from '@/lib/request-context';
import { PUT } from './[id]/route';
import { POST as deactivate } from './[id]/deactivate/route';
import { GET as getHolderOptions } from './holder-options/route';
import { GET as getList, POST } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-118：收款帳戶 route 的 response body。連線是 PGlite 的 app_rw，RLS 生效。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  // actAs() 的使用者是 orgA 的成員。持有人必須在成員清單內（MIL-187），所以補上成員關係
  await addMember(kit.orgA, TEST_USER_ID, TEST_PARTY_ID);
  actAs(kit.orgA);
});

/** 建立 party、帳號與組織成員關係。回傳 party ID。 */
async function addMember(orgId: string, userId = newUlid(), partyId = newUlid(), displayName = '路由測試帳號'): Promise<string> {
  await kit.asOwner(async (db) => {
    await db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [
      partyId,
      `${partyId.toLowerCase()}@example.com`,
      displayName,
    ]);
    await db.query(`INSERT INTO control.users (id, party_id) VALUES ($1, $2)`, [userId, partyId]);
    await db.query(`INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'staff')`, [newUlid(), orgId, userId]);
  });
  return partyId;
}

const body = (over: Record<string, unknown> = {}) => ({
  name: '王先生的台新帳戶',
  holderKind: 'lessor',
  holderName: '王大明',
  method: 'bank',
  bankCode: '812',
  accountLast4: '0123',
  ...over,
});

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const post = (payload: unknown) =>
  POST(new NextRequest('http://localhost/api/payment-accounts', { method: 'POST', body: JSON.stringify(payload) }));
const put = (id: string, payload: unknown) =>
  PUT(new NextRequest('http://localhost/api/payment-accounts/x', { method: 'PUT', body: JSON.stringify(payload) }), {
    params: Promise.resolve({ id }),
  });
const stop = (id: string) =>
  deactivate(new NextRequest('http://localhost/api/payment-accounts/x/deactivate', { method: 'POST' }), { params: Promise.resolve({ id }) });

async function create(payload = body()): Promise<{ id: string; cashAccountId: string | null }> {
  const res = await post(payload);
  expect(res.status).toBe(201);
  return (await json(res)).data;
}

describe('POST /api/payment-accounts', () => {
  it('登錄銀行帳戶回 201 與 ID，同時補上持有人的現金收取帳戶', async () => {
    const { id, cashAccountId } = await create();
    expect(isUlid(id)).toBe(true);
    expect(isUlid(cashAccountId!)).toBe(true);
  });

  it('清單只給介面需要的欄位：沒有 account_kind，現金收取用 isCash 表示，全文沒有「信託」', async () => {
    await create();
    const res = await getList();
    const text = JSON.stringify(await json(res));
    expect(text).not.toContain('account_kind');
    expect(text).not.toContain('accountKind');
    expect(text).not.toContain('信託');
    expect(text).not.toContain('trust');
    const { data } = JSON.parse(text);
    expect(data.map((a: { isCash: boolean }) => a.isCash).sort()).toEqual([false, true]);
  });

  it('沒有指定持有人時，持有人預設是目前登入者', async () => {
    const { id } = await create();
    const list = (await json(await getList())).data as { id: string; holderPartyId: string | null }[];
    expect(list.find((a) => a.id === id)!.holderPartyId).toBe(TEST_PARTY_ID);
  });

  it('持有人選本組織的其他成員：用請求帶的 party', async () => {
    const colleague = await addMember(kit.orgA);
    const { id } = await create(body({ holderPartyId: colleague }));
    const list = (await json(await getList())).data as { id: string; holderPartyId: string | null }[];
    expect(list.find((a) => a.id === id)!.holderPartyId).toBe(colleague);
  });

  it('持有人指到不存在的 party 回 422，不寫入任何帳戶', async () => {
    const res = await post(body({ holderPartyId: newUlid() }));
    expect(res.status).toBe(422);
    expect(await json(res)).toEqual({ error: '持有人必須從成員清單中選擇' });
    expect(((await json(await getList())).data as unknown[]).length).toBe(0);
  });

  it('持有人指到別的組織的成員回 422，回應與不存在的 party 逐位元相同', async () => {
    const theirs = await addMember(kit.orgB);
    const responses = await Promise.all([post(body({ holderPartyId: theirs })), post(body({ holderPartyId: newUlid() })), post(body({ holderPartyId: 'not-a-ulid' }))]);
    const texts = await Promise.all(responses.map((r) => r.text()));
    expect(responses.map((r) => r.status)).toEqual([422, 422, 422]);
    expect(new Set(texts).size).toBe(1);
  });

  it('持有人不是字串回 400', async () => {
    expect((await post(body({ holderPartyId: 123 }))).status).toBe(400);
  });

  it.each([
    ['缺名稱', body({ name: '' })],
    ['完整帳號', body({ accountLast4: '1234567890' })],
    ['未知收款方式', body({ method: 'escrow' })],
  ])('本文有誤回 400：%s', async (_label, payload) => {
    const res = await post(payload);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: expect.any(String) });
  });

  it('現金收取已存在時回 409', async () => {
    await create();
    const res = await post(body({ method: 'cash', bankCode: undefined, accountLast4: undefined }));
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe('這位持有人已有現金收取帳戶');
  });

  it('沒有登入回 401', async () => {
    actAsError(new Unauthenticated());
    expect((await post(body())).status).toBe(401);
  });
});

describe('PUT /api/payment-accounts/[id]', () => {
  it('沒有分錄引用時可以改持有人與遮罩識別', async () => {
    const { id } = await create();
    expect((await put(id, body({ holderName: '王小明', accountLast4: '9999' }))).status).toBe(200);
  });

  it('有分錄引用後改持有人回 409，訊息提示「停用並新增」；只改名稱仍成功', async () => {
    const { id } = await create();
    await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
      // 鏡像帳的 case_id 掛了 org.cases 的複合外鍵（MIL-123），分錄需要一個真實的案件
      const caseId = newUlid();
      await tx.query(
        `INSERT INTO org.cases (id, org_id, kind, state, business_type, title)
         VALUES ($1, $2, 'lease', 'active', 'self_managed', '測試案件')`,
        [caseId, kit.orgA],
      );
      const journalId = newUlid();
      await tx.query(
        `INSERT INTO org.ledger_journals (id, org_id, case_id, business_event_type, business_event_id, effective_date)
         VALUES ($1, $2, $3, 'receipt_confirmed', 'EVT1', '2026-11-08')`,
        [journalId, kit.orgA, caseId],
      );
      await tx.query(
        `INSERT INTO org.ledger_entries (id, org_id, case_id, journal_id, line_no, account, debit, credit) VALUES
           ($1, $2, $3, $4, 1, $5, 100, 0), ($6, $2, $3, $4, 2, $7, 0, 100)`,
        [newUlid(), kit.orgA, caseId, journalId, `asset.bank.${id}`, newUlid(), `liability.deposit.${caseId}`],
      );
    });
    const locked = await put(id, body({ holderName: '王小明' }));
    expect(locked.status).toBe(409);
    expect((await json(locked)).error).toContain('停用並新增');
    expect((await put(id, body({ name: '只改名稱' }))).status).toBe(200);
  });

  it('改持有人：選本組織的其他成員成功；不存在的 party 與別的組織的成員都回 422，帳戶不變', async () => {
    const { id } = await create();
    const colleague = await addMember(kit.orgA);
    const theirs = await addMember(kit.orgB);
    const rejected = await Promise.all([put(id, body({ holderPartyId: newUlid() })), put(id, body({ holderPartyId: theirs }))]);
    expect(rejected.map((r) => r.status)).toEqual([422, 422]);
    expect(new Set(await Promise.all(rejected.map((r) => r.text()))).size).toBe(1);
    const unchanged = (await json(await getList())).data as { id: string; holderPartyId: string | null }[];
    expect(unchanged.find((a) => a.id === id)!.holderPartyId).toBe(TEST_PARTY_ID);

    expect((await put(id, body({ holderPartyId: colleague }))).status).toBe(200);
    const changed = (await json(await getList())).data as { id: string; holderPartyId: string | null }[];
    expect(changed.find((a) => a.id === id)!.holderPartyId).toBe(colleague);
  });

  it('別的組織的帳戶、不存在的帳戶、格式錯誤的 ID，回應逐位元相同', async () => {
    const { id } = await create();
    actAs(kit.orgB);
    const responses = await Promise.all([put(id, body()), put(newUlid(), body()), put('not-a-ulid', body())]);
    const texts = await Promise.all(responses.map((r) => r.text()));
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404]);
    expect(new Set(texts).size).toBe(1);
  });
});

describe('POST /api/payment-accounts/[id]/deactivate', () => {
  it('停用後清單顯示已停用；再停用回 409', async () => {
    const { id } = await create();
    expect((await stop(id)).status).toBe(200);
    const list = (await json(await getList())).data as { id: string; active: boolean }[];
    expect(list.find((a) => a.id === id)!.active).toBe(false);
    expect((await stop(id)).status).toBe(409);
  });

  it('別的組織的帳戶停用不到，回 404', async () => {
    const { id } = await create();
    actAs(kit.orgB);
    expect((await stop(id)).status).toBe(404);
    actAs(kit.orgA);
    const list = (await json(await getList())).data as { id: string; active: boolean }[];
    expect(list.find((a) => a.id === id)!.active).toBe(true);
  });
});

describe('GET /api/payment-accounts/holder-options', () => {
  const asRole = (role: 'admin' | 'staff' | 'viewer') =>
    actAsContext({ kind: 'org', orgId: kit.orgA, orgKind: 'owner', userId: TEST_USER_ID, partyId: TEST_PARTY_ID, role, requestId: 'test' });

  it('列出本組織的成員，每人只有 partyId 與 displayName，另給目前登入者的 selfPartyId', async () => {
    const colleague = await addMember(kit.orgA, newUlid(), newUlid(), '同事小王');
    const body = await json(await getHolderOptions());
    expect(body.selfPartyId).toBe(TEST_PARTY_ID);
    expect([...body.data].sort((a: { partyId: string }, b: { partyId: string }) => a.partyId.localeCompare(b.partyId))).toEqual(
      [
        { partyId: TEST_PARTY_ID, displayName: '路由測試帳號' },
        { partyId: colleague, displayName: '同事小王' },
      ].sort((a, b) => a.partyId.localeCompare(b.partyId)),
    );
  });

  it('不列出別的組織的人員，回應也沒有 email', async () => {
    const theirs = await addMember(kit.orgB, newUlid(), newUlid(), '乙組織的人');
    const res = await getHolderOptions();
    const text = await res.text();
    expect(text).not.toContain(theirs);
    expect(text).not.toContain('乙組織的人');
    expect(text).not.toContain('@');
    expect(text).not.toContain('email');
  });

  it('列入本組織案件的成員（不是組織成員）', async () => {
    const tenant = newUlid();
    await kit.asOwner(async (db) => {
      await db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, '林承租')`, [tenant, `${tenant.toLowerCase()}@example.com`]);
    });
    const caseId = newUlid();
    await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
      await tx.query(
        `INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', 'active', 'self_managed', '測試案件')`,
        [caseId, kit.orgA],
      );
      await tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'lessee')`, [newUlid(), kit.orgA, caseId, tenant]);
    });
    const body = await json(await getHolderOptions());
    expect(body.data.map((o: { partyId: string }) => o.partyId)).toContain(tenant);
  });

  it('viewer 不能管理收款帳戶，所以拿不到選單，回 403', async () => {
    asRole('viewer');
    expect((await getHolderOptions()).status).toBe(403);
  });

  it('沒有登入回 401', async () => {
    actAsError(new Unauthenticated());
    expect((await getHolderOptions()).status).toBe(401);
  });
});
