import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as deskDetail } from '@/app/api/desk/ownership/[id]/route';
import { POST as deskDecision } from '@/app/api/desk/ownership/[id]/decision/route';
import { GET as deskFile } from '@/app/api/desk/ownership/[id]/file/route';
import { GET as deskConflict } from '@/app/api/desk/ownership/[id]/conflict/route';
import { GET as deskConflictFile } from '@/app/api/desk/ownership/[id]/conflict/file/route';
import { POST as deskContact } from '@/app/api/desk/ownership/[id]/contacts/route';
import { POST as deskConflictDecision } from '@/app/api/desk/ownership/[id]/conflict-decision/route';
import { POST as postAnchorKey } from '@/app/api/properties/[id]/anchor-key/route';
import { POST as postConsent } from '@/app/api/properties/[id]/ownership/consent/route';
import { GET as getOwnership, POST as postOwnership } from '@/app/api/properties/[id]/ownership/route';
import { GET as getOne } from '@/app/api/properties/[id]/route';
import { GET as getList, POST as postProperty } from '@/app/api/properties/route';
import { resolveRequestContext } from '@/lib/auth/login-flow';
import { Unauthenticated } from '@/lib/request-context';
import { CONFLICT_CONTACT_DRAFT, FAILED_NOTIFICATION_KIND, FAILED_NOTIFICATION_TITLE, LAPSED_NOTIFICATION, VERIFIED_NOTIFICATION, failedNotificationBody } from '@/lib/ownership/messages';
import { withTx } from '@/lib/pg/database';
import { actAs, actAsContext, actAsError } from '@/lib/pg/route-test-kit';
import { setupPracticeKit, type PracticeKit } from '@/lib/practice-entities/test-kit';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));
let kit: PracticeKit;
vi.mock('@/lib/file-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/file-store')>()),
  getFileStore: () => kit.store,
}));

// MIL-208 資料段：兩方都通過核對時，營運者的處理，以及它對兩方的輸出的影響（安全驗收：滲透測試）。
// 主要 seam：route handler 直接呼叫，配 PGlite 與切換組織。資料庫函式本身的案例在 src/lib/pg/ownership-conflict.test.ts。
//
// 「後來的一方」叫 B，「先前的一方」叫 A。key 固定，兩邊登錄同一個鍵。

const KEY = { city: 'A', town: '02', section: '0021', buildingNo: '20800', subNo: '' };
const PDF = new TextEncoder().encode('%PDF-1.7\n謄本內容');
const A_OWNER = '甲大明';
const B_OWNER = '乙小華';
const A_MASKED = '甲○明';
const B_MASKED = '乙○華';

beforeAll(async () => {
  kit = await setupPracticeKit();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  actAs(kit.kit.orgA);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response) => res.json() as Promise<Record<string, any>>;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body?: unknown) => new Request('http://localhost/x', body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });

async function actAsOperator() {
  const op = await kit.operatorAccount();
  actAsContext(await resolveRequestContext(op.token, new Date(Date.now() + 120_000), 'test'));
  return op;
}

async function createProperty(name: string): Promise<string> {
  const res = await postProperty(
    new NextRequest('http://localhost/api/properties', {
      method: 'POST',
      body: JSON.stringify({ name, address: '台北市大安區和平東路二段 100 號 3 樓', equipment: [], anchor: { key: KEY } }),
    }),
  );
  expect(res.status).toBe(201);
  return (await json(res)).data.id;
}

async function consentAndUpload(propertyId: string, claimedOwner: string) {
  expect((await postConsent(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ decision: 'agree' }) }), ctx(propertyId))).status).toBe(200);
  const form = new FormData();
  form.set('claimed_owner', claimedOwner);
  form.set('acquired_at', '2026-11-01');
  form.set('file', new File([PDF as BlobPart], '謄本.pdf', { type: 'application/pdf' }));
  const res = await postOwnership(new NextRequest('http://localhost/x', { method: 'POST', body: form }), ctx(propertyId));
  expect(res.status).toBe(201);
}

const openItemOf = async (orgId: string): Promise<string> => {
  const rows = await kit.kit.asOwner(async (db) =>
    (await db.query<{ id: string; payload: Record<string, string> }>(`SELECT id, payload FROM registry.review_items WHERE type = 'leasing_authority' AND status = 'open' ORDER BY created_at`)).rows,
  );
  return rows.find((r) => r.payload.claimant_org_id === orgId)!.id;
};

const decideCheck = (itemId: string, masked: string) =>
  deskDecision(req({ key_match: true, holder_match: true, holder_masked: masked, reason: '謄本相符' }), ctx(itemId));

/** 營運者查看一個項目：詳情加原檔，等於營運者在等待核對時會做的事。 */
async function operatorViews(itemId: string) {
  await actAsOperator();
  expect((await deskDetail(req(), ctx(itemId))).status).toBe(200);
  expect((await deskFile(req(), ctx(itemId))).status).toBe(200);
}

interface Party {
  orgId: string;
  propertyId: string;
  itemId: string;
}

/** 先前的一方登錄、送件，營運者判定通過。 */
async function earlierVerified(): Promise<Party> {
  actAs(kit.kit.orgA);
  const propertyId = await createProperty('A 的物件');
  await consentAndUpload(propertyId, A_OWNER);
  const itemId = await openItemOf(kit.kit.orgA);
  await actAsOperator();
  expect((await decideCheck(itemId, A_MASKED)).status).toBe(200);
  return { orgId: kit.kit.orgA, propertyId, itemId };
}

/** 後來的一方登錄同一個鍵並送件。不判定。 */
async function laterSubmitted(): Promise<Party> {
  actAs(kit.kit.orgB);
  const propertyId = await createProperty('B 的物件');
  await consentAndUpload(propertyId, B_OWNER);
  return { orgId: kit.kit.orgB, propertyId, itemId: await openItemOf(kit.kit.orgB) };
}

const asOrg = <T>(orgId: string, fn: (tx: import('@/lib/pg/with-tx').OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId, partyId: '00000000000000000000000004' }, fn);

/**
 * 一個組織從外面能觀察到的全部輸出：物件的三個讀取 API、再送件與修正建號的回應、通知、稽核事件、節點與送件列。
 * 回傳原始內容（含 ID），要比對形狀時用 shape()。
 */
async function observe(party: Party) {
  actAs(party.orgId);
  const get = async (res: Response) => ({ status: res.status, body: await json(res) });
  const property = await get(await getOne(new NextRequest('http://localhost/x'), ctx(party.propertyId)));
  const list = await get(await getList(new NextRequest('http://localhost/api/properties')));
  const ownership = await get(await getOwnership(new NextRequest('http://localhost/x'), ctx(party.propertyId)));
  // 再送一次：已有待核對的送件時 409，不寫檔也不寫事件。已通過的回 409，已失效或失敗的會真的送出，所以只在待核對時試
  let resubmit: unknown = null;
  let rekey: unknown = null;
  if (ownership.body.data.node_status === 'pending_verification') {
    const form = new FormData();
    form.set('claimed_owner', '重送');
    form.set('acquired_at', '2026-11-01');
    form.set('file', new File([PDF as BlobPart], 'x.pdf', { type: 'application/pdf' }));
    resubmit = await get(await postOwnership(new NextRequest('http://localhost/x', { method: 'POST', body: form }), ctx(party.propertyId)));
    rekey = await get(await postAnchorKey(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ ...KEY, buildingNo: '20999' }) }), ctx(party.propertyId)));
  }
  const rows = await asOrg(party.orgId, async (tx) => ({
    notifications: (await tx.query('SELECT kind, title, body, link_path, read_at FROM org.notifications ORDER BY id')).rows,
    events: (await tx.query('SELECT actor_type, actor_id, action, object_type, object_id, payload FROM audit.events ORDER BY seq')).rows,
    nodes: (await tx.query('SELECT id, anchor_id, status, key_match, holder_match, holder_masked, current_submission_id FROM org.ownership_nodes ORDER BY created_at')).rows,
    submissions: (await tx.query('SELECT id, node_id, seq, claimed_owner_name, acquired_at, city_code, town_code, section_code, building_no, sub_no, file_name FROM org.ownership_submissions ORDER BY seq')).rows,
  }));
  return { property, list, ownership, resubmit, rekey, ...rows };
}

const ULID = /[0-9A-HJKMNP-TV-Z]{26}/g;
/** 把 ID 與時間換成固定樣本，留下形狀。同一個 ID 在同一份內容換成同一個樣本。 */
function shape(value: unknown): unknown {
  const seen = new Map<string, string>();
  const text = JSON.stringify(value, (_k, v) => (v instanceof Date ? '<t>' : v)).replace(ULID, (m) => {
    if (!seen.has(m)) seen.set(m, `<id${seen.size}>`);
    return seen.get(m)!;
  });
  // 顯示編碼的後六碼由單位 ID 算出，每次不同
  return JSON.parse(text.replace(/"display_code":"[A-Z]\d{2}-[0-9A-Z]+"/g, '"display_code":"<code>"').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<t>').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}/g, '<t>'));
}

describe('後來的一方的輸出：有衝突與沒有衝突（營運者還沒判定）逐位元相同（驗收 4、13）', () => {
  it('營運者做了同樣的查看之後，判定被停住，後來的一方的所有輸出與沒有衝突的對照組相同', async () => {
    // 有衝突：A 先通過，B 後來，營運者查看 B 的項目，判定兩項都相符，被停住
    await earlierVerified();
    const b = await laterSubmitted();
    await operatorViews(b.itemId);
    const held = await decideCheck(b.itemId, B_MASKED);
    expect(held.status).toBe(200);
    expect((await json(held)).data.outcome).toBe('held');
    const withConflict = await observe(b);

    // 對照組：沒有 A，B 一個人送件，營運者做同樣的查看，還沒判定
    await kit.reset();
    const alone = await laterSubmitted();
    await operatorViews(alone.itemId);
    const baseline = await observe(alone);

    expect(shape(withConflict)).toEqual(shape(baseline));
    // 確認比對有東西：節點待驗證、通知空、事件含營運者的存取
    expect(withConflict.ownership.body.data).toMatchObject({ verification_status: 'pending_verification', node_status: 'pending_verification', can_submit: false });
    expect(withConflict.notifications).toEqual([]);
    expect((withConflict.events as { action: string }[]).map((e) => e.action)).toContain('operator.access');
  });

  it('營運者沒有先查看就判定，結果也相同（判定這個動作不在後來的一方的鏈留痕）', async () => {
    await earlierVerified();
    const b = await laterSubmitted();
    await actAsOperator();
    expect((await json(await decideCheck(b.itemId, B_MASKED))).data.outcome).toBe('held');
    const withConflict = await observe(b);

    await kit.reset();
    const alone = await laterSubmitted();
    const baseline = await observe(alone);
    expect(shape(withConflict)).toEqual(shape(baseline));
  });

  it('營運者反覆判定、記聯絡、讀並列內容（不讀後來的一方的組織）：後來的一方的輸出仍相同', async () => {
    await earlierVerified();
    const b = await laterSubmitted();
    await operatorViews(b.itemId);
    await decideCheck(b.itemId, B_MASKED);
    await decideCheck(b.itemId, B_MASKED);
    expect((await deskContact(req({ target: 'later', channel: 'phone', outcome: '已通話' }), ctx(b.itemId))).status).toBe(201);
    expect((await deskContact(req({ target: 'earlier', channel: 'email', outcome: '已寄信' }), ctx(b.itemId))).status).toBe(201);
    expect((await deskConflict(req(), ctx(b.itemId))).status).toBe(200);
    const withConflict = await observe(b);

    await kit.reset();
    const alone = await laterSubmitted();
    await operatorViews(alone.itemId);
    expect(shape(withConflict)).toEqual(shape(await observe(alone)));
  });

  it('先前的一方：有人來衝突前後，所有輸出相同，也沒有通知', async () => {
    const a = await earlierVerified();
    const before = await observe(a);
    const b = await laterSubmitted();
    await operatorViews(b.itemId);
    await decideCheck(b.itemId, B_MASKED);
    await deskContact(req({ target: 'later', channel: 'phone', outcome: '已通話' }), ctx(b.itemId));
    const after = await observe(a);
    expect(after).toEqual(before);
    // 通知只有它自己通過核對時的那一則，沒有新的
    expect(after.notifications.map((n) => (n as { kind: string }).kind)).toEqual(['property.verification_passed']);
    expect(after.ownership.body.data).toMatchObject({ verification_status: 'verified', node_status: 'verified' });
  });
});

describe('三種決定之後，任一方的輸出都不含另一方的資料（驗收 13）', () => {
  interface Ids {
    a: Party;
    b: Party;
    conflictId: string;
    aNode: string;
    bNode: string;
    aSub: string;
    bSub: string;
  }

  async function heldCase(): Promise<Ids> {
    const a = await earlierVerified();
    const b = await laterSubmitted();
    await operatorViews(b.itemId);
    expect((await json(await decideCheck(b.itemId, B_MASKED))).data.outcome).toBe('held');
    await actAsOperator();
    const view = (await json(await deskConflict(req(), ctx(b.itemId)))).data;
    return { a, b, conflictId: view.id, aNode: view.earlier.nodeId, bNode: view.later.nodeId, aSub: view.earlier.submissionId, bSub: view.later.submissionId };
  }

  const decideRoute = (itemId: string, body: Record<string, unknown>) => deskConflictDecision(req(body), ctx(itemId));

  /** 另一方的識別資料：組織、物件、節點、送件、項目、個案、名稱、姓名、遮罩值。 */
  function secretsOf(p: Party, node: string, sub: string, conflictId: string, names: string[]): string[] {
    return [p.orgId, p.propertyId, p.itemId, node, sub, conflictId, ...names];
  }

  function assertNoLeak(label: string, observed: unknown, secrets: string[]) {
    const text = JSON.stringify(observed);
    for (const s of secrets) expect({ label, leaked: text.includes(s) ? s : null }).toEqual({ label, leaked: null });
  }

  it('後來的成立、先前的失效：雙方各自的通知與事件互不含對方；失效的通知用泛用文字', async () => {
    const ids = await heldCase();
    // 先前的一方有一個進行中的案件：決定的回應只回數字
    await actAsOperator();
    const res = await decideRoute(ids.b.itemId, { decision: 'later_prevails', reason: '乙方補件後確認為屋主' });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ decision: 'later_prevails', affected_case_count: 0 });

    const a = await observe(ids.a);
    const b = await observe(ids.b);
    assertNoLeak('A', a, secretsOf(ids.b, ids.bNode, ids.bSub, ids.conflictId, ['B 組織', B_OWNER, B_MASKED, 'B 的物件']));
    assertNoLeak('B', b, secretsOf(ids.a, ids.aNode, ids.aSub, ids.conflictId, ['A 組織', A_OWNER, A_MASKED, 'A 的物件']));

    // 先前的一方：節點失效，對外是「待平台核對文件」，能重新送件；收到固定的失效通知
    expect(a.ownership.body.data).toMatchObject({ verification_status: 'pending_verification', node_status: null, can_submit: true });
    expect(a.notifications.slice(1)).toEqual([expect.objectContaining({ kind: LAPSED_NOTIFICATION.kind, title: LAPSED_NOTIFICATION.title, body: LAPSED_NOTIFICATION.body, link_path: `/properties/${ids.a.propertyId}` })]);
    expect(LAPSED_NOTIFICATION.body).not.toMatch(/其他|另一|別人|別的|有人|已有|占用|取得/);
    expect((a.events as { action: string }[]).map((e) => e.action).filter((x) => x !== 'operator.access')).toContain('rental_right.revoke');
    // 後來的一方：與一般判定通過相同的通知
    expect(b.ownership.body.data).toMatchObject({ verification_status: 'verified', node_status: 'verified', holder_masked: B_MASKED });
    expect(b.notifications).toEqual([expect.objectContaining({ kind: VERIFIED_NOTIFICATION.kind, title: VERIFIED_NOTIFICATION.title, body: VERIFIED_NOTIFICATION.body })]);
  });

  it('後來的成立：與沒有衝突時直接通過核對，後來的一方的通知與事件形狀相同', async () => {
    const ids = await heldCase();
    await actAsOperator();
    await decideRoute(ids.b.itemId, { decision: 'later_prevails', reason: '確認' });
    const withConflict = await observe(ids.b);

    await kit.reset();
    const alone = await laterSubmitted();
    await actAsOperator();
    expect((await decideCheck(alone.itemId, B_MASKED)).status).toBe(200);
    const plain = await observe(alone);

    expect(shape(withConflict.notifications)).toEqual(shape(plain.notifications));
    expect(shape(withConflict.ownership)).toEqual(shape(plain.ownership));
    const judge = (o: typeof plain) => (o.events as { action: string; payload: unknown }[]).filter((e) => e.action === 'rental_right.judge');
    expect(shape(judge(withConflict))).toEqual(shape(judge(plain)));
  });

  it.each([
    ['key_mismatch', false, true],
    ['holder_mismatch', true, false],
    ['both_mismatch', false, false],
  ] as const)('後來的不成立（%s）：既有的驗證失敗訊息，先前的一方不受影響，後來的一方能重新送件', async (basis, keyMatch, holderMatch) => {
    const ids = await heldCase();
    const aBefore = await observe(ids.a);
    await actAsOperator();
    const res = await decideRoute(ids.b.itemId, { decision: 'later_rejected', basis, reason: '乙方的謄本不足以證明' });
    expect((await json(res)).data).toEqual({ decision: 'later_rejected', affected_case_count: 0 });

    const a = await observe(ids.a);
    const b = await observe(ids.b);
    expect(a).toEqual(aBefore);
    assertNoLeak('A', a, secretsOf(ids.b, ids.bNode, ids.bSub, ids.conflictId, ['B 組織', B_OWNER, B_MASKED, 'B 的物件']));
    assertNoLeak('B', b, secretsOf(ids.a, ids.aNode, ids.aSub, ids.conflictId, ['A 組織', A_OWNER, A_MASKED, 'A 的物件']));
    expect(b.ownership.body.data).toMatchObject({ verification_status: 'failed', node_status: 'failed', can_submit: true });
    expect(b.notifications).toEqual([
      expect.objectContaining({
        kind: FAILED_NOTIFICATION_KIND,
        title: FAILED_NOTIFICATION_TITLE,
        body: failedNotificationBody({ keyMatch, holderMatch }),
      }),
    ]);
    // 與沒有衝突、營運者直接判定不符的使用者相同
    await kit.reset();
    const alone = await laterSubmitted();
    await actAsOperator();
    await deskDecision(req({ key_match: keyMatch, holder_match: holderMatch, holder_masked: B_MASKED, reason: '不符' }), ctx(alone.itemId));
    const plain = await observe(alone);
    expect(shape(b.notifications)).toEqual(shape(plain.notifications));
    expect(shape(b.ownership)).toEqual(shape(plain.ownership));
  });

  it('兩方並存：雙方都是已核對，各自的物件列表與詳情只有自己的資料，輸出互不含對方的識別資料', async () => {
    const ids = await heldCase();
    const aBefore = await observe(ids.a);
    await actAsOperator();
    const res = await decideRoute(ids.b.itemId, { decision: 'coexist', reason: '兩人共有' });
    expect((await json(res)).data).toEqual({ decision: 'coexist', affected_case_count: 0 });

    const a = await observe(ids.a);
    const b = await observe(ids.b);
    // 先前的一方：沒有任何變化，沒有通知
    expect(a).toEqual(aBefore);
    expect(a.notifications.map((n) => (n as { kind: string }).kind)).toEqual(['property.verification_passed']);
    expect(b.ownership.body.data).toMatchObject({ verification_status: 'verified', node_status: 'verified' });
    expect(b.notifications).toEqual([expect.objectContaining({ kind: VERIFIED_NOTIFICATION.kind })]);

    assertNoLeak('A', a, secretsOf(ids.b, ids.bNode, ids.bSub, ids.conflictId, ['B 組織', B_OWNER, B_MASKED, 'B 的物件']));
    assertNoLeak('B', b, secretsOf(ids.a, ids.aNode, ids.aSub, ids.conflictId, ['A 組織', A_OWNER, A_MASKED, 'A 的物件']));
    // 列表只有自己的物件
    expect((a.list.body.data as { id: string }[]).map((p) => p.id)).toEqual([ids.a.propertyId]);
    expect((b.list.body.data as { id: string }[]).map((p) => p.id)).toEqual([ids.b.propertyId]);
    // 錨點與租賃單位的 ID 也不外露：合併只在 registry 內，兩邊的輸出只有自己的單位 ID
    const registryIds = await kit.registry<{ anchor_id: string; unit_id: string; org: string }>(
      `SELECT c.earlier_anchor_id AS anchor_id, (SELECT u.id FROM registry.rental_units u WHERE u.anchor_id = c.earlier_anchor_id AND u.unit_type = 'whole') AS unit_id, 'a' AS org FROM registry.ownership_conflicts c
       UNION ALL
       SELECT u.anchor_id, u.id, 'b' FROM registry.rental_units u WHERE u.merged_into_id IS NOT NULL`,
    );
    const aIds = registryIds.find((r) => r.org === 'a')!;
    const bIds = registryIds.find((r) => r.org === 'b')!;
    assertNoLeak('A', a, [bIds.anchor_id, bIds.unit_id]);
    assertNoLeak('B', b, [aIds.anchor_id, aIds.unit_id]);
    // 顯示編碼沿合併走到存續的單位：兩邊的編碼相同（同一個物件）。編碼是單位 ID 的雜湊，不是 ID
    expect(b.property.body.data.unit.display_code).toBe(a.property.body.data.unit.display_code);
    // 後來的一方的物件仍顯示自己的鍵
    expect(b.property.body.data.anchor).toMatchObject({ building_no: '20800' });
    expect(b.property.body.data.verification_status).toBe('verified');
    // 被合併的 ID 持續有效：後來的一方仍用自己的物件 ID 讀得到
    expect(b.property.status).toBe(200);
  });
});

describe('route 與權限', () => {
  async function held() {
    await earlierVerified();
    const b = await laterSubmitted();
    await actAsOperator();
    await decideCheck(b.itemId, B_MASKED);
    return b;
  }

  it('三個新 route 只有平台營運者：沒登入 401，組織成員 403', async () => {
    const b = await held();
    const calls = [
      () => deskConflict(req(), ctx(b.itemId)),
      () => deskConflictFile(req(), ctx(b.itemId)),
      () => deskContact(req({ target: 'later', channel: 'phone', outcome: 'x' }), ctx(b.itemId)),
      () => deskConflictDecision(req({ decision: 'coexist', reason: 'x' }), ctx(b.itemId)),
    ];
    actAsError(new Unauthenticated());
    for (const call of calls) expect((await call()).status).toBe(401);
    actAs(kit.kit.orgB);
    for (const call of calls) expect((await call()).status).toBe(403);
    actAs(kit.kit.orgA);
    for (const call of calls) expect((await call()).status).toBe(403);
    expect((await kit.registry('SELECT 1 FROM registry.ownership_contacts')).length).toBe(0);
  });

  it('不是 ULID 與沒有個案的項目：404', async () => {
    const a = await earlierVerified();
    await actAsOperator();
    for (const id of ['abc', '00000000000000000000000000']) {
      expect((await deskConflict(req(), ctx(id))).status).toBe(404);
      expect((await deskContact(req({ target: 'later', channel: 'phone', outcome: 'x' }), ctx(id))).status).toBe(404);
      expect((await deskConflictDecision(req({ decision: 'coexist', reason: 'x' }), ctx(id))).status).toBe(404);
    }
    // 一般項目（沒有衝突）
    expect((await deskConflict(req(), ctx(a.itemId))).status).toBe(404);
    expect((await deskConflictDecision(req({ decision: 'coexist', reason: 'x' }), ctx(a.itemId))).status).toBe(404);
  });

  it('並列讀取：雙方的欄位、聯絡紀錄；先前的一方通過核對的時間與取得時間；沒有主張的所有權人', async () => {
    const b = await held();
    expect((await deskContact(req({ target: 'earlier', channel: 'phone', outcome: '請對方補充說明' }), ctx(b.itemId))).status).toBe(201);
    const res = await deskConflict(req(), ctx(b.itemId));
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data).toMatchObject({
      itemId: b.itemId,
      status: 'open',
      decision: null,
      claimedKey: { cityCode: 'A', townCode: '02', sectionCode: '0021', buildingNo: '20800', subNo: '000' },
      later: { orgId: kit.kit.orgB, orgName: 'B 組織', holderMasked: B_MASKED },
      earlier: { orgId: kit.kit.orgA, orgName: 'A 組織', holderMasked: A_MASKED },
    });
    expect(data.earlier.acquiredAt).toMatch(/^2026-10-31T16:00:00/);
    expect(data.earlier.verifiedAt).toEqual(expect.any(String));
    expect(data.contacts).toEqual([expect.objectContaining({ target: 'earlier', channel: 'phone', outcome: '請對方補充說明' })]);
    expect(JSON.stringify(data)).not.toMatch(new RegExp(`${A_OWNER}|${B_OWNER}|object_key|sha256`));
    // 既有的詳情多 conflictId 與 conflictStatus
    expect((await json(await deskDetail(req(), ctx(b.itemId)))).data.item).toMatchObject({ held: true, conflictId: data.id, conflictStatus: 'open' });
  });

  it('先前一方的原檔：寫稽核事件到先前一方的鏈，行為者是營運者，工單號不含後來一方的 ID', async () => {
    const b = await held();
    const res = await deskConflictFile(req(), ctx(b.itemId));
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toContain('謄本內容');
    const events = await asOrg(kit.kit.orgA, async (tx) => (await tx.query<{ actor_type: string; action: string; payload: Record<string, unknown> }>('SELECT actor_type, action, payload FROM audit.events ORDER BY seq')).rows);
    const last = events.slice(-2);
    expect(last.map((e) => [e.actor_type, e.action])).toEqual([['operator', 'operator.access'], ['operator', 'vault.read']]);
    expect(JSON.stringify(events)).not.toContain(b.itemId);
    expect(JSON.stringify(events)).not.toContain(b.propertyId);
  });

  it('聯絡：欄位檢查、時間檢查；紀錄人是登入的營運者；只存在平台表，任何一方的組織沒有新事件', async () => {
    const b = await held();
    const eventsBefore = [await asOrg(kit.kit.orgA, async (tx) => (await tx.query('SELECT 1 FROM audit.events')).rows.length), await asOrg(kit.kit.orgB, async (tx) => (await tx.query('SELECT 1 FROM audit.events')).rows.length)];
    for (const [body, field] of [
      [{ channel: 'phone', outcome: 'x' }, 'target'],
      [{ target: 'both', channel: 'phone', outcome: 'x' }, 'target'],
      [{ target: 'later', channel: 'sms', outcome: 'x' }, 'channel'],
      [{ target: 'later', channel: 'phone', outcome: '  ' }, 'outcome'],
      [{ target: 'later', channel: 'phone', outcome: 'x'.repeat(501) }, 'outcome'],
      [{ target: 'later', channel: 'phone', outcome: 'x', contacted_at: 'yesterday' }, 'contactedAt'],
      [{ target: 'later', channel: 'phone', outcome: 'x', contacted_at: new Date(Date.now() + 86_400_000).toISOString() }, 'contactedAt'],
    ] as const) {
      const res = await deskContact(req(body), ctx(b.itemId));
      expect({ status: res.status, field: (await json(res)).field }).toEqual({ status: 400, field });
    }
    // 早於個案建立
    expect((await deskContact(req({ target: 'later', channel: 'phone', outcome: 'x', contacted_at: '2020-01-01T00:00:00Z' }), ctx(b.itemId))).status).toBe(400);
    expect((await deskContact(req({ target: 'later', channel: 'other', outcome: '電話未接', recorded_by: 'someone' }), ctx(b.itemId))).status).toBe(201);
    const op = await kit.operatorAccount();
    expect(await kit.registry('SELECT recorded_by, outcome FROM registry.ownership_contacts')).toEqual([{ recorded_by: op.userId, outcome: '電話未接' }]);
    const eventsAfter = [await asOrg(kit.kit.orgA, async (tx) => (await tx.query('SELECT 1 FROM audit.events')).rows.length), await asOrg(kit.kit.orgB, async (tx) => (await tx.query('SELECT 1 FROM audit.events')).rows.length)];
    expect(eventsAfter).toEqual(eventsBefore);
  });

  it('決定：欄位檢查；後來的不成立必須填不符的項目；第二次決定 409；平台鏈有三種事件', async () => {
    const b = await held();
    for (const [body, field] of [
      [{ reason: 'x' }, 'decision'],
      [{ decision: 'merge', reason: 'x' }, 'decision'],
      [{ decision: 'coexist' }, 'reason'],
      [{ decision: 'coexist', reason: 'x'.repeat(501) }, 'reason'],
      [{ decision: 'later_rejected', reason: 'x' }, 'basis'],
      [{ decision: 'later_rejected', reason: 'x', basis: 'other' }, 'basis'],
      [{ decision: 'coexist', reason: 'x', basis: 'key_mismatch' }, 'basis'],
    ] as const) {
      const res = await deskConflictDecision(req(body), ctx(b.itemId));
      expect({ status: res.status, field: (await json(res)).field }).toEqual({ status: 400, field });
    }
    await deskContact(req({ target: 'later', channel: 'phone', outcome: '通話' }), ctx(b.itemId));
    expect((await deskConflictDecision(req({ decision: 'later_rejected', basis: 'holder_mismatch', reason: '不足以證明' }), ctx(b.itemId))).status).toBe(200);
    const again = await deskConflictDecision(req({ decision: 'coexist', reason: '改變主意' }), ctx(b.itemId));
    expect(again.status).toBe(409);
    // 一般判定路徑對已結案的項目仍回 409
    expect((await decideCheck(b.itemId, B_MASKED)).status).toBe(409);
    const platformEvents = await asOrg('00000000000000000000000001', async (tx) =>
      (await tx.query<{ action: string; actor_type: string; payload: Record<string, unknown> }>(`SELECT action, actor_type, payload FROM audit.events WHERE action LIKE 'ownership.conflict.%' ORDER BY seq`)).rows,
    );
    expect(platformEvents.map((e) => [e.action, e.actor_type])).toEqual([
      ['ownership.conflict.open', 'operator'],
      ['ownership.conflict.contact', 'operator'],
      ['ownership.conflict.decide', 'operator'],
    ]);
    expect(JSON.stringify(platformEvents)).not.toMatch(/通話|不足以證明/);
  });

  it('含證號的遮罩值：判定 route 回 400（資料庫層的檢查在 ownership-conflict.test.ts）', async () => {
    const b = await held();
    // 表單檢查先擋下，回 400
    expect((await decideCheck(b.itemId, 'A123456789')).status).toBe(400);
  });

  it('聯絡文字初稿不提到另一方，每句 40 字以內', () => {
    expect(CONFLICT_CONTACT_DRAFT).not.toMatch(/其他|另一|別人|別的|有人|重複|衝突/);
    for (const sentence of CONFLICT_CONTACT_DRAFT.split(/[。？]/).filter(Boolean)) expect(sentence.length).toBeLessThanOrEqual(40);
  });
});
