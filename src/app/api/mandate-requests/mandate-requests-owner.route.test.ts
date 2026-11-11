import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { actAsError } from '@/lib/pg/route-test-kit';
import { Unauthenticated } from '@/lib/request-context';
import {
  actAsAccount,
  cookieOf,
  expectSameResponse,
  json,
  jsonRequest,
  loginNow,
  ownerAccount,
  sampleDraft,
  setupPracticeKit,
  snapshot,
  verifiedPractice,
  type Account,
  type OwnerAccount,
  type PracticeKit,
} from '@/lib/mandate-requests/test-kit';
import { SUBMITTED_NOTICE_BODY, SUBMITTED_NOTICE_TITLE, UNITS_UNAVAILABLE_MESSAGE, WITHDRAWN_NOTICE_BODY, WITHDRAWN_NOTICE_TITLE } from '@/lib/mandate-requests/messages';
import { GET as getNotifications } from '../notifications/route';
import { GET as getProperties, POST as postProperty } from '../properties/route';
import { GET as getPropertyOne } from '../properties/[id]/route';
import { POST as postClaim } from './link/[code]/claim/route';
import { GET as getLink } from './link/[code]/route';
import { POST as postConfirm } from './[id]/confirm-draft/route';
import { GET as getOne } from './[id]/route';
import { POST as postSubmit } from './[id]/submit/route';
import { POST as postWithdraw } from './[id]/withdraw/route';
import { GET as getList, POST as postCreate } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));
let pk: PracticeKit;
vi.mock('@/lib/file-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/file-store')>()),
  getFileStore: () => pk.store,
}));

// MIL-206 資料段第 2 步：屋主登入綁定連結、確認代填資料、選租賃單位送出、收回、站內通知。
// 屋主與業者用真實的 email 驗證碼登入。claim 走真的 session cookie，其餘 route 用 actAs 切換組織。

beforeAll(async () => {
  pk = await setupPracticeKit();
}, 60_000);
afterAll(() => pk.close());

let practice: Account;
let owner: OwnerAccount;
beforeEach(async () => {
  await pk.reset();
  practice = await verifiedPractice(pk, 'practice-a@example.com');
  owner = await ownerAccount(pk, 'wang@example.com');
  actAsAccount(practice, 'practice');
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const linkCtx = (code: string) => ({ params: Promise.resolve({ code }) });
const NO_UNIT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const asPractice = (a: Account = practice) => actAsAccount(a, 'practice');
const asOwner = (o: { orgId: string; partyId: string; userId: string } = owner) => actAsAccount(o, 'owner');

async function createOk(body: Record<string, unknown> = { kind: 'management' }) {
  asPractice();
  const res = await postCreate(jsonRequest('/api/mandate-requests', 'POST', body));
  expect(res.status).toBe(201);
  const data = (await json(res)).data;
  return { ...data, code: (data.link_path as string).replace('/request/', '') } as Record<string, any> & { id: string; code: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const claim = (code: string, token: string, body: unknown = {}) =>
  postClaim(jsonRequest(`/api/mandate-requests/link/${code}/claim`, 'POST', body, cookieOf(token)), linkCtx(code));
const confirm = (id: string, consent: unknown = 'agree') => postConfirm(jsonRequest('/x', 'POST', { consent }), ctx(id));
const submit = (id: string, unitIds: unknown) => postSubmit(jsonRequest('/x', 'POST', { unit_ids: unitIds }), ctx(id));
const withdraw = (id: string) => postWithdraw(jsonRequest('/x', 'POST'), ctx(id));
const readOne = async (id: string) => json(await getOne(jsonRequest('/x', 'GET'), ctx(id)));

/** 屋主登錄一個物件，回傳租賃單位 ID。 */
async function registerUnit(as: { orgId: string; partyId: string; userId: string } = owner): Promise<string> {
  asOwner(as);
  const res = await postProperty(jsonRequest('/api/properties', 'POST', sampleDraft()));
  expect(res.status).toBe(201);
  const id = (await json(res)).data.id as string;
  const list = (await json(await getProperties())).data as Array<{ id: string; rental_unit_id: string }>;
  return list.find((p) => p.id === id)!.rental_unit_id;
}

async function claimOk(code: string, o: OwnerAccount = owner) {
  const res = await claim(code, o.token);
  expect(res.status).toBe(200);
  return (await json(res)).data;
}

/** 把申請在資料庫裡的時間往前推，模擬時間經過。 */
async function age(id: string, days: number, column: 'link' | 'submitted') {
  const interval = `(${days} || ' days')::interval`;
  await pk.kit.asOwner((db) =>
    db.query(
      column === 'link'
        ? `UPDATE registry.mandate_requests SET created_at = created_at - ${interval}, link_expires_at = link_expires_at - ${interval} WHERE id = $1`
        : `UPDATE registry.mandate_requests SET submitted_at = submitted_at - ${interval} WHERE id = $1`,
      [id],
    ),
  );
}

const notificationsOf = async (a: Account): Promise<Array<Record<string, any>>> => { // eslint-disable-line @typescript-eslint/no-explicit-any
  asPractice(a);
  return (await json(await getNotifications(jsonRequest('/api/notifications', 'GET') as never))).data.items;
};

describe('屋主綁定連結（claim）', () => {
  it('已經是屋主組織成員的帳號：綁定成功，回申請（業者名稱、統編、種類、代填資料與個資告知文字）', async () => {
    const data = await createOk({ kind: 'management', draft: sampleDraft() });
    const claimed = await claimOk(data.code);
    expect(claimed.created_owner_org).toBe(false);
    expect(claimed.request).toMatchObject({
      id: data.id,
      kind: 'management',
      kind_label: '委託管理申請',
      status: 'pending_owner',
      practice: { name: expect.stringContaining('安心代管有限公司'), tax_id: expect.stringMatching(/^\d{8}$/) },
      has_transcript: false,
      confirmed_unit_id: null,
      unit_ids: [],
    });
    expect(claimed.request.draft.address).toContain('和平東路');
    expect(claimed.request.consent_notice).toMatchObject({ notice_type: 'transcript_id_pii', version: expect.any(Number) });
    const [row] = await pk.registry<{ owner_org_id: string }>('SELECT owner_org_id FROM registry.mandate_requests WHERE id = $1', [data.id]);
    expect(row.owner_org_id).toBe(owner.orgId);
  });

  it('住宅包租申請顯示住宅包租申請', async () => {
    const data = await createOk({ kind: 'master_lease' });
    expect((await claimOk(data.code)).request.kind_label).toBe('住宅包租申請');
  });

  it('第一次登入還沒有組織的帳號：用屋主名稱建立屋主的組織，再綁定', async () => {
    const data = await createOk({ kind: 'management' });
    const { token } = await loginNow(pk, 'new-owner@example.com');
    const before = (await pk.registry<{ n: string }>(`SELECT count(*)::text AS n FROM control.orgs WHERE kind = 'owner'`))[0].n;
    const res = await claim(data.code, token, { owner_name: '李小姐' });
    expect(res.status).toBe(200);
    const body = (await json(res)).data;
    expect(body.created_owner_org).toBe(true);
    expect(body.request.id).toBe(data.id);
    const orgs = await pk.registry<{ name: string; kind: string }>(`SELECT name, kind FROM control.orgs WHERE name = '李小姐'`);
    expect(orgs).toEqual([{ name: '李小姐', kind: 'owner' }]);
    expect((await pk.registry<{ n: string }>(`SELECT count(*)::text AS n FROM control.orgs WHERE kind = 'owner'`))[0].n).toBe(String(Number(before) + 1));
  });

  it('第一次登入沒填屋主名稱：400，不建組織；連結無效：404，不建組織', async () => {
    const data = await createOk({ kind: 'management' });
    const { token } = await loginNow(pk, 'new-owner@example.com');
    const countOrgs = async () => (await pk.registry<{ n: string }>('SELECT count(*)::text AS n FROM control.orgs'))[0].n;
    const before = await countOrgs();
    const noName = await claim(data.code, token, {});
    expect(noName.status).toBe(400);
    expect(await json(noName)).toMatchObject({ code: 'owner_name_required' });
    expect((await claim('A'.repeat(43), token, { owner_name: '李小姐' })).status).toBe(404);
    expect((await claim('short', token, { owner_name: '李小姐' })).status).toBe(404);
    expect(await countOrgs()).toBe(before);
  });

  it('業者組織的帳號不能當屋主綁定：403，不論碼有沒有效，回應相同', async () => {
    const data = await createOk();
    const valid = await snapshot(await claim(data.code, practice.token));
    const unknown = await snapshot(await claim('A'.repeat(43), practice.token));
    expect(valid.status).toBe(403);
    expect(JSON.parse(valid.text)).toMatchObject({ code: 'not_owner' });
    expectSameResponse(unknown, valid);
    expect((await pk.registry('SELECT 1 FROM registry.mandate_requests WHERE owner_org_id IS NOT NULL'))).toEqual([]);
  });

  it('沒有登入：401', async () => {
    const data = await createOk();
    const res = await postClaim(jsonRequest('/x', 'POST', {}), linkCtx(data.code));
    expect(res.status).toBe(401);
  });

  it('同一個組織重複綁定：200，仍是同一份申請', async () => {
    const data = await createOk();
    await claimOk(data.code);
    expect((await claimOk(data.code)).request.id).toBe(data.id);
  });

  it('已被第一個屋主組織綁定後，別的屋主組織的 claim 與連結頁，回應與無效連結逐位元相同', async () => {
    const data = await createOk();
    await claimOk(data.code);
    const other = await ownerAccount(pk, 'lee@example.com', '李先生');
    const unknownClaim = await snapshot(await claim('A'.repeat(43), other.token));
    const claimed = await snapshot(await claim(data.code, other.token));
    expect(claimed.status).toBe(404);
    expectSameResponse(claimed, unknownClaim);
    // 連結頁：另一個屋主組織登入後打開，與不存在的碼相同
    asOwner(other);
    const view = await snapshot(await getLink(jsonRequest('/x', 'GET'), linkCtx(data.code)));
    const unknownView = await snapshot(await getLink(jsonRequest('/x', 'GET'), linkCtx('A'.repeat(43))));
    expectSameResponse(view, unknownView);
    // 第二個人也讀不到這份申請與它的代填資料
    const read = await snapshot(await getOne(jsonRequest('/x', 'GET'), ctx(data.id)));
    const unknownRead = await snapshot(await getOne(jsonRequest('/x', 'GET'), ctx(NO_UNIT)));
    expectSameResponse(read, unknownRead);
    expect((await json(await getList())).data).toEqual([]);
  });

  it('過期、已送出與已收回的連結不能綁定，回應與無效連結相同', async () => {
    const expired = await createOk();
    await age(expired.id, 8, 'link');
    const unknown = await snapshot(await claim('A'.repeat(43), owner.token));
    expectSameResponse(await snapshot(await claim(expired.code, owner.token)), unknown);

    const submitted = await createOk();
    await claimOk(submitted.code);
    const unit = await registerUnit();
    asOwner();
    expect((await submit(submitted.id, [unit])).status).toBe(200);
    expectSameResponse(await snapshot(await claim(submitted.code, owner.token)), unknown);
    expect((await withdraw(submitted.id)).status).toBe(200);
    expectSameResponse(await snapshot(await claim(submitted.code, owner.token)), unknown);
  });

  it('claim 不寄任何 email（只有登入驗證碼那封，是屋主自己要求的）', async () => {
    const data = await createOk();
    const before = pk.mailer.sent.length;
    await claimOk(data.code);
    expect(pk.mailer.sent.length).toBe(before);
  });
});

describe('業者端看不出屋主有沒有打開連結（驗收 13）', () => {
  it('沒人打開、已綁定、已確認代填資料，業者讀到的申請與列表逐位元相同', async () => {
    const data = await createOk({ kind: 'management', draft: sampleDraft() });
    const practiceView = async () => {
      asPractice();
      const one = await snapshot(await getOne(jsonRequest('/x', 'GET'), ctx(data.id)));
      const list = await snapshot(await getList());
      const link = await snapshot(await getLink(jsonRequest('/x', 'GET'), linkCtx(data.code)));
      return { one, list, link };
    };
    const untouched = await practiceView();
    await claimOk(data.code);
    const claimed = await practiceView();
    asOwner();
    expect((await confirm(data.id, 'agree')).status).toBe(201);
    const confirmed = await practiceView();
    for (const later of [claimed, confirmed]) {
      expectSameResponse(later.one, untouched.one);
      expectSameResponse(later.list, untouched.list);
      expectSameResponse(later.link, untouched.link);
    }
    // 業者的通知也沒有任何東西
    expect(await notificationsOf(practice)).toEqual([]);
  });

  it('屋主沒送出就離開：不寫通知，收回會被擋下，業者的狀態不變', async () => {
    const data = await createOk();
    await claimOk(data.code);
    asOwner();
    const res = await withdraw(data.id);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'not_submitted' });
    expect(await notificationsOf(practice)).toEqual([]);
    asPractice();
    expect((await readOne(data.id)).data.status).toBe('pending_owner');
  });

  it('claim 與確認不改變業者的稽核鏈：業者的鏈沒有 request.claim 與 request.confirm_draft', async () => {
    const data = await createOk({ kind: 'management', draft: sampleDraft() });
    await claimOk(data.code);
    asOwner();
    await confirm(data.id, 'decline');
    const actions = await auditActionsOf(practice.orgId);
    expect(actions).toContain('request.create');
    expect(actions).not.toContain('request.claim');
    expect(actions).not.toContain('request.confirm_draft');
    const ownerActions = await auditActionsOf(owner.orgId);
    expect(ownerActions).toEqual(expect.arrayContaining(['request.claim', 'request.confirm_draft']));
  });
});

/** 某個組織的稽核鏈上的動作（RLS 只讓組織看到自己的鏈）。 */
async function auditActionsOf(orgId: string): Promise<string[]> {
  const { withTx } = await import('@/lib/pg/database');
  const rows = await withTx({ kind: 'org', orgId }, (tx) => tx.query<{ action: string }>('SELECT action FROM audit.events ORDER BY seq'));
  return rows.rows.map((r) => r.action);
}

describe('確認業者代填的資料（confirm-draft）', () => {
  it('同意個資告知：物件登錄在屋主的組織，回應與一般登錄相同（201、待核對）', async () => {
    const data = await createOk({ kind: 'management', draft: sampleDraft() });
    await claimOk(data.code);
    asOwner();
    const res = await confirm(data.id, 'agree');
    expect(res.status).toBe(201);
    const body = (await json(res)).data;
    expect(body).toMatchObject({ verification_status: 'pending_verification', transcript: 'none', rental_unit_id: expect.any(String) });
    // 物件在屋主的組織，業者看不到
    const list = (await json(await getProperties())).data as Array<{ id: string; rental_unit_id: string; verification_status: string }>;
    expect(list.find((p) => p.id === body.id)).toMatchObject({ rental_unit_id: body.rental_unit_id, verification_status: 'pending_verification' });
    asPractice();
    expect(((await json(await getProperties())).data as unknown[]).length).toBe(0);
    expect((await getPropertyOne(jsonRequest('/x', 'GET'), ctx(body.id))).status).toBe(404);
  });

  it('代填的建號與別的組織已登錄的相同時，回應與不相同時相同（形狀、狀態碼）', async () => {
    const key = sampleDraft().anchor;
    const normal = await createOk({ kind: 'management', draft: sampleDraft({ anchor: key }) });
    const other = await ownerAccount(pk, 'lee@example.com', '李先生');
    await registerUnitWithKey(other, key);
    await claimOk(normal.code);
    asOwner();
    const colliding = await confirm(normal.id, 'agree');

    const lone = await createOk({ kind: 'management', draft: sampleDraft() });
    const third = await ownerAccount(pk, 'chen@example.com', '陳先生');
    await claimOk(lone.code, third);
    asOwner(third);
    const clean = await confirm(lone.id, 'agree');

    expect(colliding.status).toBe(clean.status);
    const a = (await json(colliding)).data;
    const b = (await json(clean)).data;
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect({ ...a, id: 'X', rental_unit_id: 'X' }).toEqual({ ...b, id: 'X', rental_unit_id: 'X' });
  });

  it('屋主自己已經登錄同一個建號：沿用既有物件（existing），不重複建立', async () => {
    const key = sampleDraft().anchor;
    const mine = await registerUnitWithKey(owner, key);
    const data = await createOk({ kind: 'management', draft: sampleDraft({ anchor: key }) });
    await claimOk(data.code);
    asOwner();
    const res = await confirm(data.id, 'agree');
    expect(res.status).toBe(200);
    const body = (await json(res)).data;
    expect(body).toMatchObject({ existing: true, rental_unit_id: mine });
    expect(((await json(await getProperties())).data as unknown[]).length).toBe(1);
  });

  it('重複確認：200 already_confirmed，不重複登錄', async () => {
    const data = await createOk({ kind: 'management', draft: sampleDraft() });
    await claimOk(data.code);
    asOwner();
    const first = (await json(await confirm(data.id))).data;
    const again = await confirm(data.id);
    expect(again.status).toBe(200);
    expect((await json(again)).data).toEqual({ already_confirmed: true, rental_unit_id: first.rental_unit_id });
    expect(((await json(await getProperties())).data as unknown[]).length).toBe(1);
    expect((await readOne(data.id)).data.confirmed_unit_id).toBe(first.rental_unit_id);
  });

  it('不同意個資告知也能確認：decline，不轉謄本', async () => {
    const data = await createOk({ kind: 'management', draft: sampleDraft() });
    await claimOk(data.code);
    asOwner();
    const res = await confirm(data.id, 'decline');
    expect(res.status).toBe(201);
    expect((await json(res)).data.transcript).toBe('declined');
  });

  it('沒有代填資料、沒綁定、consent 缺漏，各回對應錯誤', async () => {
    const noDraft = await createOk({ kind: 'management' });
    await claimOk(noDraft.code);
    asOwner();
    expect((await confirm(noDraft.id)).status).toBe(409);
    expect((await json(await confirm(noDraft.id))).code).toBe('no_draft');
    const unbound = await createOk({ kind: 'management', draft: sampleDraft() });
    asOwner();
    expect((await confirm(unbound.id)).status).toBe(404);
    expect((await confirm(noDraft.id, 'maybe')).status).toBe(400);
    expect((await confirm(NO_UNIT)).status).toBe(404);
  });

  it('業者組織與唯讀成員不能確認', async () => {
    const data = await createOk({ kind: 'management', draft: sampleDraft() });
    await claimOk(data.code);
    asPractice();
    expect((await confirm(data.id)).status).toBe(403);
    actAsAccount(owner, 'owner', 'viewer');
    expect((await confirm(data.id)).status).toBe(403);
  });
});

async function registerUnitWithKey(as: { orgId: string; partyId: string; userId: string }, anchor: unknown): Promise<string> {
  asOwner(as);
  const res = await postProperty(jsonRequest('/api/properties', 'POST', sampleDraft({ anchor })));
  expect(res.status).toBe(201);
  const id = (await json(res)).data.id as string;
  const list = (await json(await getProperties())).data as Array<{ id: string; rental_unit_id: string }>;
  return list.find((p) => p.id === id)!.rental_unit_id;
}

describe('屋主送出（submit）', () => {
  it('一次申請含多個租賃單位：待業者接受，業者收到站內通知（只有種類與數量）', async () => {
    const data = await createOk({ kind: 'management' });
    await claimOk(data.code);
    const [u1, u2] = [await registerUnit(), await registerUnit()];
    asOwner();
    const res = await submit(data.id, [u1, u2, u1]);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ id: data.id, status: 'pending_practice', unit_ids: [u1, u2].sort() });

    const mine = await notificationsOf(practice);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      kind: 'request.submitted',
      title: SUBMITTED_NOTICE_TITLE('management'),
      body: SUBMITTED_NOTICE_BODY('management', 2),
      linkPath: `/requests/${data.id}`,
    });
    // 通知不帶屋主的 email 與名稱
    expect(JSON.stringify(mine)).not.toContain('wang@example.com');
    expect(JSON.stringify(mine)).not.toContain('王先生');

    // 業者讀到：待業者接受，租賃單位數量，代填資料已清掉；沒有任何屋主資料
    asPractice();
    const view = (await readOne(data.id)).data;
    expect(view).toMatchObject({ status: 'pending_practice', unit_count: 2, draft: null });
    expect(JSON.stringify(view)).not.toContain(owner.orgId);
    expect(JSON.stringify(view)).not.toContain(u1);
  });

  it('住宅包租申請的通知用法定名稱', async () => {
    const data = await createOk({ kind: 'master_lease' });
    await claimOk(data.code);
    const u = await registerUnit();
    asOwner();
    await submit(data.id, [u]);
    expect((await notificationsOf(practice))[0]).toMatchObject({ title: '收到一份住宅包租申請', body: SUBMITTED_NOTICE_BODY('master_lease', 1) });
  });

  it('送出不寄任何 email', async () => {
    const data = await createOk();
    await claimOk(data.code);
    const u = await registerUnit();
    const before = pk.mailer.sent.length;
    asOwner();
    await submit(data.id, [u]);
    expect(pk.mailer.sent.length).toBe(before);
  });

  it('送出後，業者看不到屋主的物件：任何 route 都讀不到', async () => {
    const data = await createOk({ kind: 'management', draft: sampleDraft() });
    await claimOk(data.code);
    asOwner();
    const confirmed = (await json(await confirm(data.id))).data;
    await submit(data.id, [confirmed.rental_unit_id]);
    asPractice();
    expect(((await json(await getProperties())).data as unknown[]).length).toBe(0);
    expect((await getPropertyOne(jsonRequest('/x', 'GET'), ctx(confirmed.id))).status).toBe(404);
    // 申請本身也沒有物件資料
    const text = JSON.stringify((await readOne(data.id)).data);
    expect(text).not.toContain('和平東路');
    expect(text).not.toContain(confirmed.rental_unit_id);
  });

  it('送出不讓任何組織之間的關係變成 bound，也沒有 mandatary 案件成員', async () => {
    const data = await createOk();
    await claimOk(data.code);
    const u = await registerUnit();
    asOwner();
    await submit(data.id, [u]);
    const [entity] = await pk.registry<{ id: string }>('SELECT id FROM registry.practice_entities WHERE org_id = $1', [practice.orgId]);
    const { withTx } = await import('@/lib/pg/database');
    // caller_relation 是內部函式（app_rw 不能執行），用 app_owner 並設成屋主組織的脈絡來呼叫
    const relation = await pk.kit.asOwner(async (db) => {
      await db.query(`SELECT set_config('app.org_id', $1, false)`, [owner.orgId]);
      try {
        return (await db.query<{ r: string }>('SELECT registry.caller_relation($1) AS r', [entity.id])).rows[0].r;
      } finally {
        await db.query(`SELECT set_config('app.org_id', '', false)`);
      }
    });
    expect(relation).toBe('none');
    const members = await withTx({ kind: 'org', orgId: owner.orgId, partyId: owner.partyId }, (tx) =>
      tx.query('SELECT 1 FROM org.case_members WHERE relation = $1', ['mandatary']),
    );
    expect(members.rows).toEqual([]);
  });

  it('沒選租賃單位：400。租賃單位不是自己的、不存在、格式錯誤：404，三者回應逐位元相同', async () => {
    const data = await createOk();
    await claimOk(data.code);
    const other = await ownerAccount(pk, 'lee@example.com', '李先生');
    const foreign = await registerUnit(other);
    asOwner();
    expect((await submit(data.id, [])).status).toBe(400);
    expect((await submit(data.id, undefined)).status).toBe(400);
    const a = await snapshot(await submit(data.id, [foreign]));
    const b = await snapshot(await submit(data.id, [NO_UNIT]));
    const c = await snapshot(await submit(data.id, ['not-a-unit']));
    expect(a.status).toBe(404);
    expectSameResponse(a, b);
    expectSameResponse(c, b);
    expect(JSON.parse(a.text)).toMatchObject({ code: 'unit_not_found' });
    expect(await notificationsOf(practice)).toEqual([]);
  });

  it('不是這個組織的申請與不存在的申請：404 逐位元相同', async () => {
    const data = await createOk();
    const u = await registerUnit();
    asOwner();
    const unbound = await snapshot(await submit(data.id, [u]));
    const unknown = await snapshot(await submit(NO_UNIT, [u]));
    expect(unbound.status).toBe(404);
    expectSameResponse(unbound, unknown);
  });

  it('送出兩次：第二次 409 not_pending；連結失效後 409 expired', async () => {
    const data = await createOk();
    await claimOk(data.code);
    const u = await registerUnit();
    asOwner();
    expect((await submit(data.id, [u])).status).toBe(200);
    const again = await submit(data.id, [u]);
    expect(again.status).toBe(409);
    expect((await json(again)).code).toBe('not_pending');

    const old = await createOk();
    await claimOk(old.code);
    await age(old.id, 8, 'link');
    asOwner();
    const late = await submit(old.id, [await registerUnit()]);
    expect(late.status).toBe(409);
    expect((await json(late)).code).toBe('expired');
  });

  it('租賃單位已有進行中的申請：不能再送出，訊息固定，不提是哪一家業者', async () => {
    const other = await verifiedPractice(pk, 'practice-b@example.com');
    const u = await registerUnit();
    const first = await createOk();
    await claimOk(first.code);
    asOwner();
    expect((await submit(first.id, [u])).status).toBe(200);

    // 另一家業者的申請，同一個租賃單位
    asPractice(other);
    const second = await postCreate(jsonRequest('/x', 'POST', { kind: 'master_lease' }));
    const secondData = (await json(second)).data;
    await claimOk(secondData.link_path.replace('/request/', ''));
    asOwner();
    const blocked = await submit(secondData.id, [u]);
    expect(blocked.status).toBe(409);
    expect(await json(blocked)).toEqual({ error: UNITS_UNAVAILABLE_MESSAGE, code: 'units_unavailable' });
    // 訊息不含業者的名稱
    expect(JSON.stringify(await json(await submit(secondData.id, [u])))).not.toContain('安心代管');
    // 另一家業者什麼都沒變
    asPractice(other);
    expect((await readOne(secondData.id)).data.status).toBe('pending_owner');
    expect(await notificationsOf(other)).toEqual([]);
  });

  it('被佔用與被誰佔用無關：同一個單位被自己送給甲、或被其他種類的申請佔用，拒絕的回應逐位元相同', async () => {
    const other = await verifiedPractice(pk, 'practice-b@example.com');
    const u1 = await registerUnit();
    const u2 = await registerUnit();
    const toA = await createOk({ kind: 'management' });
    await claimOk(toA.code);
    asOwner();
    await submit(toA.id, [u1]);
    asPractice(other);
    const toBdata = (await json(await postCreate(jsonRequest('/x', 'POST', { kind: 'master_lease' })))).data;
    await claimOk(toBdata.link_path.replace('/request/', ''));
    asOwner();
    await submit(toBdata.id, [u2]);
    // 第三份申請（甲）想要 u1 和 u2：兩個單位分別被甲與乙佔用，回應相同
    const third = await createOk({ kind: 'master_lease' });
    await claimOk(third.code);
    asOwner();
    const onlyA = await snapshot(await submit(third.id, [u1]));
    const onlyB = await snapshot(await submit(third.id, [u2]));
    const both = await snapshot(await submit(third.id, [u1, u2]));
    expect(onlyA.status).toBe(409);
    expectSameResponse(onlyB, onlyA);
    expectSameResponse(both, onlyA);
  });

  it('收回後租賃單位釋出；送出後 7 天業者沒接受而失效，租賃單位也釋出', async () => {
    const u = await registerUnit();
    const first = await createOk();
    await claimOk(first.code);
    asOwner();
    await submit(first.id, [u]);
    const second = await createOk({ kind: 'master_lease' });
    await claimOk(second.code);
    asOwner();
    expect((await submit(second.id, [u])).status).toBe(409);
    expect((await withdraw(first.id)).status).toBe(200);
    expect((await submit(second.id, [u])).status).toBe(200);

    // 第二份失效（送出滿 7 天）後，第三份能用同一個租賃單位
    await age(second.id, 7, 'submitted');
    const third = await createOk();
    await claimOk(third.code);
    asOwner();
    expect((await submit(third.id, [u])).status).toBe(200);
  });

  it('租賃單位被佔用的檢查只讀屋主自己的申請：兩位屋主各自的租賃單位互不影響', async () => {
    const other = await ownerAccount(pk, 'lee@example.com', '李先生');
    const uMine = await registerUnit();
    const uOther = await registerUnit(other);
    const a = await createOk();
    const b = await createOk();
    await claimOk(a.code);
    await claimOk(b.code, other);
    asOwner();
    expect((await submit(a.id, [uMine])).status).toBe(200);
    asOwner(other);
    expect((await submit(b.id, [uOther])).status).toBe(200);
  });

  it('唯讀成員與業者組織不能送出', async () => {
    const data = await createOk();
    await claimOk(data.code);
    const u = await registerUnit();
    actAsAccount(owner, 'owner', 'viewer');
    expect((await submit(data.id, [u])).status).toBe(403);
    asPractice();
    expect((await submit(data.id, [u])).status).toBe(403);
    actAsError(new Unauthenticated());
    expect((await submit(data.id, [u])).status).toBe(401);
  });
});

describe('屋主收回（withdraw）', () => {
  async function submitted() {
    const data = await createOk();
    await claimOk(data.code);
    const u = await registerUnit();
    asOwner();
    await submit(data.id, [u]);
    return { data, u };
  }

  it('業者接受之前能收回：狀態已收回，業者收到「申請已收回」，不寫原因', async () => {
    const { data } = await submitted();
    asOwner();
    const res = await withdraw(data.id);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ id: data.id, status: 'withdrawn' });
    const notes = await notificationsOf(practice);
    expect(notes.map((n) => n.title)).toEqual([WITHDRAWN_NOTICE_TITLE, SUBMITTED_NOTICE_TITLE('management')]);
    expect(notes[0]).toMatchObject({ kind: 'request.withdrawn', body: WITHDRAWN_NOTICE_BODY('management'), linkPath: `/requests/${data.id}` });
    expect(JSON.stringify(notes)).not.toContain('王先生');
    asPractice();
    expect((await readOne(data.id)).data).toMatchObject({ status: 'withdrawn', withdrawn_at: expect.any(String) });
  });

  it('收回後連結頁無效，重複收回 409，別的組織收回 404', async () => {
    const { data } = await submitted();
    asOwner();
    expect((await withdraw(data.id)).status).toBe(200);
    expect((await withdraw(data.id)).status).toBe(409);
    expect((await json(await withdraw(data.id))).code).toBe('not_pending');
    const other = await ownerAccount(pk, 'lee@example.com', '李先生');
    asOwner(other);
    expectSameResponse(await snapshot(await withdraw(data.id)), await snapshot(await withdraw(NO_UNIT)));
    actAsError(new Unauthenticated());
    expect((await getLink(jsonRequest('/x', 'GET'), linkCtx(data.code))).status).toBe(404);
  });

  it('送出滿 7 天已失效，不能收回', async () => {
    const { data } = await submitted();
    await age(data.id, 8, 'submitted');
    asOwner();
    const res = await withdraw(data.id);
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('expired');
    asPractice();
    expect((await readOne(data.id)).data.status).toBe('expired');
  });

  it('業者組織與唯讀成員不能收回', async () => {
    const { data } = await submitted();
    asPractice();
    expect((await withdraw(data.id)).status).toBe(403);
    actAsAccount(owner, 'owner', 'viewer');
    expect((await withdraw(data.id)).status).toBe(403);
  });
});

describe('屋主讀自己的申請', () => {
  it('列表只含自己綁定的申請', async () => {
    const mine = await createOk();
    const notMine = await createOk();
    await claimOk(mine.code);
    asOwner();
    const list = (await json(await getList())).data as Array<{ id: string }>;
    expect(list.map((r) => r.id)).toEqual([mine.id]);
    void notMine;
  });

  it('失效後：狀態是 expired，代填資料與個資告知不再回傳', async () => {
    const data = await createOk({ kind: 'management', draft: sampleDraft() });
    await claimOk(data.code);
    await age(data.id, 8, 'link');
    asOwner();
    expect((await readOne(data.id)).data).toMatchObject({ status: 'expired', draft: null, consent_notice: null, deadline: null });
  });
});
