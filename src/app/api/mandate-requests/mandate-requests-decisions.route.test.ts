import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { actAsContext } from '@/lib/pg/route-test-kit';
import {
  actAsAccount,
  expectSameResponse,
  json,
  jsonRequest,
  ownerAccount,
  sampleDraft,
  setupPracticeKit,
  snapshot,
  verifiedPractice,
  loginNow,
  type Account,
  type OwnerAccount,
  type PracticeKit,
} from '@/lib/mandate-requests/test-kit';
import {
  ACCEPTED_NOTICE_BODY,
  ACCEPTED_NOTICE_TITLE,
  DECLINED_NOTICE_BODY,
  DECLINED_NOTICE_TITLE,
  ENDED_BY_OWNER_NOTICE_BODY,
  ENDED_BY_OWNER_NOTICE_TITLE,
  ENDED_BY_PRACTICE_NOTICE_BODY,
  ENDED_BY_PRACTICE_NOTICE_TITLE,
} from '@/lib/mandate-requests/messages';
import { newUlid } from '@/lib/pg/ulid';
import { GET as getCases } from '../cases/route';
import { GET as getNotifications } from '../notifications/route';
import { GET as getPropertyOne } from '../properties/[id]/route';
import { GET as getProperties, POST as postProperty } from '../properties/route';
import { POST as postClaim } from './link/[code]/claim/route';
import { POST as postAccept } from './[id]/accept/route';
import { POST as postDecline } from './[id]/decline/route';
import { POST as postEnd } from './[id]/end/route';
import { GET as getOne } from './[id]/route';
import { POST as postSubmit } from './[id]/submit/route';
import { POST as postWithdraw } from './[id]/withdraw/route';
import { GET as getCandidates } from './manager-candidates/route';
import { POST as postCreate } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));
let pk: PracticeKit;
vi.mock('@/lib/file-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/file-store')>()),
  getFileStore: () => pk.store,
}));

// MIL-210 前半資料段：業者接受、不接受、雙方結束、候選名單、站內通知、稽核與滲透。
// 業者與屋主用真實的 email 驗證碼登入。管理人員與成員角色用 app_owner 直接備，route 用 actAs 切換組織與角色。

beforeAll(async () => {
  pk = await setupPracticeKit();
}, 60_000);
afterAll(() => pk.close());

let practice: Account;
let rival: Account;
let owner: OwnerAccount;
let stranger: OwnerAccount;
let manager: string;

beforeEach(async () => {
  await pk.reset();
  practice = await verifiedPractice(pk, 'practice-a@example.com');
  rival = await verifiedPractice(pk, 'practice-b@example.com');
  owner = await ownerAccount(pk, 'wang@example.com', '王先生');
  stranger = await ownerAccount(pk, 'lee@example.com', '李先生');
  manager = await seedManager(practice);
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const linkCtx = (code: string) => ({ params: Promise.resolve({ code }) });
const NO_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const asPractice = (a: Account = practice) => actAsAccount(a, 'practice');
const asOwner = (o: OwnerAccount = owner) => actAsAccount(o, 'owner');

let seq = 0;
/** 在帳號的執業主體下備一位人員與任職（app_owner 直接寫）。預設是已驗證、任職中的租賃住宅管理人員。 */
async function seedManager(
  account: Account,
  options: { state?: 'pending' | 'verified' | 'lapsed'; kind?: string; name?: string } = {},
): Promise<string> {
  seq += 1;
  const party = newUlid();
  const practitioner = newUlid();
  const employment = newUlid();
  const kind = options.kind ?? 'rental_housing_manager';
  const serial = String(200000 + seq);
  const key = `${kind}:112:內授營:${serial}`;
  await pk.kit.asOwner(async (db) => {
    await db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)`, [party, `mgr-${seq}@example.com`, options.name ?? `林小姐${seq}`]);
    await db.query(
      `INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until, state)
       VALUES ($1, $2, $3, '112', '內授營', $4, $5, '2024-03-01', '2036-03-01', 'verified')`,
      [practitioner, party, kind, serial, key],
    );
    await db.query(
      `INSERT INTO registry.practitioner_employments (id, practitioner_id, certificate_key, certificate_kind, entity_id, state, started_on)
       VALUES ($1, $2, $3, $4, (SELECT id FROM registry.practice_entities WHERE org_id = $5), $6, '2026-01-01')`,
      [employment, practitioner, key, kind, account.orgId, options.state ?? 'verified'],
    );
  });
  return employment;
}

/** 在組織下加一位指定角色的成員，回傳可用在 actAsContext 的帳號。 */
async function addMember(orgId: string, orgKind: 'owner' | 'practice', role: 'admin' | 'staff' | 'viewer'): Promise<Account & { orgKind: 'owner' | 'practice' }> {
  const email = `${role}-${newUlid().toLowerCase()}@example.com`;
  const { token } = await loginNow(pk, email);
  const rows = await pk.registry<{ party_id: string; id: string }>(`SELECT u.party_id, u.id FROM control.users u JOIN control.parties p ON p.id = u.party_id WHERE p.email = $1`, [email]);
  await pk.kit.asOwner((db) => db.query(`INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)`, [newUlid(), orgId, rows[0].id, role]));
  return { token, orgId, orgKind, role, userId: rows[0].id, partyId: rows[0].party_id } as Account & { orgKind: 'owner' | 'practice' };
}

function actAsMember(member: { orgId: string; partyId: string; userId: string; orgKind: 'owner' | 'practice'; role: 'admin' | 'staff' | 'viewer' }): void {
  actAsContext({ kind: 'org', orgId: member.orgId, orgKind: member.orgKind, userId: member.userId, partyId: member.partyId, role: member.role, requestId: 'test' });
}

async function registerUnit(as: OwnerAccount = owner): Promise<string> {
  asOwner(as);
  const res = await postProperty(jsonRequest('/api/properties', 'POST', sampleDraft()));
  expect(res.status).toBe(201);
  const id = (await json(res)).data.id as string;
  const list = (await json(await getProperties())).data as Array<{ id: string; rental_unit_id: string }>;
  return list.find((p) => p.id === id)!.rental_unit_id;
}

/** 業者產生連結、屋主綁定並選租賃單位送出，回傳申請與屋主的租賃單位。 */
async function submitted(kind: 'management' | 'master_lease' = 'management', unitCount = 1): Promise<{ id: string; units: string[]; propertyId: string }> {
  asPractice();
  const created = await postCreate(jsonRequest('/api/mandate-requests', 'POST', { kind }));
  expect(created.status).toBe(201);
  const data = (await json(created)).data;
  const code = (data.link_path as string).replace('/request/', '');
  const claim = await postClaim(jsonRequest('/x', 'POST', {}, { cookie: `${(await import('@/lib/auth/config')).SESSION_COOKIE}=${owner.token}` }), linkCtx(code));
  expect(claim.status).toBe(200);
  const units: string[] = [];
  for (let i = 0; i < unitCount; i += 1) units.push(await registerUnit());
  asOwner();
  const res = await postSubmit(jsonRequest('/x', 'POST', { unit_ids: units }), ctx(data.id));
  expect(res.status).toBe(200);
  const propertyId = ((await json(await getProperties())).data as Array<{ id: string; rental_unit_id: string }>).find((p) => p.rental_unit_id === units[0])!.id;
  return { id: data.id as string, units, propertyId };
}

const accept = (id: string, body: unknown = { manager_employment_id: manager }) => postAccept(jsonRequest('/x', 'POST', body), ctx(id));
const decline = (id: string, body?: unknown) => postDecline(jsonRequest('/x', 'POST', body), ctx(id));
const end = (id: string) => postEnd(jsonRequest('/x', 'POST'), ctx(id));
const readOne = async (id: string) => json(await getOne(jsonRequest('/x', 'GET'), ctx(id)));

async function notificationsOf(a: { orgId: string; partyId: string; userId: string }, kind: 'owner' | 'practice'): Promise<Array<Record<string, any>>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  actAsAccount(a, kind);
  return (await json(await getNotifications(jsonRequest('/api/notifications', 'GET') as never))).data.items;
}

/** 某個組織的稽核鏈：動作與 payload（RLS 只讓組織看到自己的鏈）。 */
async function auditOf(orgId: string): Promise<Array<{ action: string; payload: Record<string, unknown> }>> {
  const { withTx } = await import('@/lib/pg/database');
  const rows = await withTx({ kind: 'org', orgId }, (tx) => tx.query<{ action: string; payload: Record<string, unknown> }>('SELECT action, payload FROM audit.events ORDER BY seq'));
  return rows.rows;
}

/** 把已接受的申請的接受時間往前推，模擬時間經過。 */
async function ageAccepted(id: string, days: number) {
  await pk.kit.asOwner((db) =>
    db.query(`UPDATE registry.mandate_requests SET accepted_at = accepted_at - ($2 || ' days')::interval WHERE id = $1`, [id, String(days)]),
  );
}
async function ageSubmitted(id: string, days: number) {
  await pk.kit.asOwner((db) =>
    db.query(`UPDATE registry.mandate_requests SET submitted_at = submitted_at - ($2 || ' days')::interval WHERE id = $1`, [id, String(days)]),
  );
}

describe('管理人員候選名單（GET manager-candidates）', () => {
  it('業者 admin：只回自己組織現在有效的租賃住宅管理人員（任職 ID、姓名、證書種類）', async () => {
    const hidden = [
      await seedManager(practice, { state: 'pending', name: '待驗證的人' }),
      await seedManager(practice, { state: 'lapsed', name: '已離職的人' }),
      await seedManager(practice, { kind: 'real_estate_broker', name: '經紀人' }),
      await seedManager(rival, { name: '別家的管理人員' }),
    ];
    asPractice();
    const res = await getCandidates();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data).toEqual([{ employment_id: manager, display_name: expect.stringContaining('林小姐'), certificate_kind: 'rental_housing_manager' }]);
    const text = JSON.stringify(body);
    for (const id of hidden) expect(text).not.toContain(id);
    for (const name of ['待驗證的人', '已離職的人', '經紀人', '別家的管理人員']) expect(text).not.toContain(name);
  });

  it('沒有合格的人時回空陣列；staff、viewer、屋主組織被拒', async () => {
    asPractice(rival);
    expect((await json(await getCandidates())).data).toEqual([]);
    for (const role of ['staff', 'viewer'] as const) {
      actAsMember(await addMember(practice.orgId, 'practice', role));
      expect((await getCandidates()).status).toBe(403);
    }
    asOwner();
    expect((await getCandidates()).status).toBe(403);
  });
});

describe('業者接受（POST accept）', () => {
  it('業者 admin 接受：狀態是已接受、帶指派的管理人員，屋主收到通知，兩邊的稽核鏈各自記錄', async () => {
    const { id } = await submitted('management', 2);
    asPractice();
    const res = await accept(id);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ id, status: 'accepted', manager_employment_id: manager, accepted_at: expect.any(String), closed_at: null, closed_by: null });

    const notes = await notificationsOf(owner, 'owner');
    expect(notes[0]).toMatchObject({ kind: 'request.accepted', title: ACCEPTED_NOTICE_TITLE, body: ACCEPTED_NOTICE_BODY('management', 2), linkPath: `/requests/${id}` });
    const noteText = JSON.stringify(notes);
    for (const leak of ['practice-a@example.com', '安心代管', '林小姐']) expect(noteText).not.toContain(leak);

    const practiceAudit = await auditOf(practice.orgId);
    expect(practiceAudit.find((e) => e.action === 'request.accept')?.payload).toEqual({ employment_id: manager });
    expect((await auditOf(owner.orgId)).map((e) => e.action)).not.toContain('request.accept');
  });

  it('屋主讀到已接受，回應沒有管理人員的任職 ID', async () => {
    const { id } = await submitted();
    asPractice();
    await accept(id);
    asOwner();
    const seen = (await readOne(id)).data;
    expect(seen).toMatchObject({ status: 'accepted', accepted_at: expect.any(String) });
    expect(Object.keys(seen)).not.toContain('manager_employment_id');
    expect(JSON.stringify(seen)).not.toContain(manager);
  });

  it('住宅包租申請的通知用法定名稱', async () => {
    const { id } = await submitted('master_lease');
    asPractice();
    expect((await accept(id)).status).toBe(200);
    expect((await notificationsOf(owner, 'owner'))[0]).toMatchObject({ body: ACCEPTED_NOTICE_BODY('master_lease', 1) });
  });

  it('沒有帶管理人員、格式錯誤：400', async () => {
    const { id } = await submitted();
    asPractice();
    for (const body of [{}, undefined, { manager_employment_id: 5 }, { manager_employment_id: 'not-a-ulid' }]) {
      const res = await postAccept(jsonRequest('/x', 'POST', body), ctx(id));
      expect(res.status).toBe(400);
      expect(await json(res)).toMatchObject({ field: 'manager_employment_id' });
    }
    expect((await readOne(id)).data.status).toBe('pending_practice');
  });

  it('指派別家業者的任職 ID：被拒，與不存在的任職 ID 回應逐位元相同', async () => {
    const { id } = await submitted();
    const theirs = await seedManager(rival);
    asPractice();
    const foreign = await snapshot(await accept(id, { manager_employment_id: theirs }));
    const missing = await snapshot(await accept(id, { manager_employment_id: NO_ID }));
    expect(foreign.status).toBe(400);
    expect(JSON.parse(foreign.text)).toMatchObject({ code: 'manager_not_eligible' });
    expectSameResponse(foreign, missing);
    expect((await readOne(id)).data.status).toBe('pending_practice');
    expect(await notificationsOf(owner, 'owner')).toEqual([]);
  });

  it('指派自己組織但沒通過驗證、已離職、不是管理人員證書的人：被拒', async () => {
    const { id } = await submitted();
    const bad = [await seedManager(practice, { state: 'pending' }), await seedManager(practice, { state: 'lapsed' }), await seedManager(practice, { kind: 'real_estate_broker' })];
    asPractice();
    for (const managerId of bad) {
      const res = await accept(id, { manager_employment_id: managerId });
      expect(res.status).toBe(400);
      expect(await json(res)).toMatchObject({ code: 'manager_not_eligible' });
    }
    expect((await readOne(id)).data.status).toBe('pending_practice');
  });

  it('任職期間已結束的管理人員被拒（期間不涵蓋現在，由同一份判定擋下）', async () => {
    const { id } = await submitted();
    const ended = await seedManager(practice);
    await pk.kit.asOwner((db) => db.query(`UPDATE registry.practitioner_employments SET ended_on = '2026-02-01' WHERE id = $1`, [ended]));
    asPractice();
    const res = await accept(id, { manager_employment_id: ended });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: 'manager_not_eligible' });
  });

  it('組織沒有合格的管理人員：409 no_eligible_manager，什麼都沒寫', async () => {
    const { id } = await submitted();
    await pk.kit.asOwner((db) => db.query(`UPDATE registry.practitioner_employments SET state = 'lapsed', ended_on = '2026-02-01' WHERE id = $1`, [manager]));
    asPractice();
    const res = await accept(id);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'no_eligible_manager' });
    expect((await readOne(id)).data.status).toBe('pending_practice');
  });

  it('staff、viewer、屋主組織不能接受', async () => {
    const { id } = await submitted();
    for (const role of ['staff', 'viewer'] as const) {
      actAsMember(await addMember(practice.orgId, 'practice', role));
      expect((await accept(id)).status).toBe(403);
    }
    asOwner();
    expect((await accept(id)).status).toBe(403);
    asPractice();
    expect((await readOne(id)).data.status).toBe('pending_practice');
  });

  it('別家業者接受：404，與不存在的申請逐位元相同', async () => {
    const { id } = await submitted();
    const theirs = await seedManager(rival);
    asPractice(rival);
    const other = await snapshot(await accept(id, { manager_employment_id: theirs }));
    const missing = await snapshot(await accept(NO_ID, { manager_employment_id: theirs }));
    expect(other.status).toBe(404);
    expectSameResponse(other, missing);
    asPractice();
    expect((await readOne(id)).data.status).toBe('pending_practice');
  });

  it('不是待業者接受或已失效：409 not_pending，已接受、已收回、已不接受、已結束、已失效的回應逐位元相同', async () => {
    const snaps: Array<Awaited<ReturnType<typeof snapshot>>> = [];
    // 已接受
    const a = await submitted();
    asPractice();
    expect((await accept(a.id)).status).toBe(200);
    snaps.push(await snapshot(await accept(a.id)));
    // 已收回
    const b = await submitted();
    asOwner();
    expect((await postWithdraw(jsonRequest('/x', 'POST'), ctx(b.id))).status).toBe(200);
    asPractice();
    snaps.push(await snapshot(await accept(b.id)));
    // 已不接受
    const c = await submitted();
    asPractice();
    expect((await decline(c.id)).status).toBe(200);
    snaps.push(await snapshot(await accept(c.id)));
    // 已結束
    expect((await end(a.id)).status).toBe(200);
    snaps.push(await snapshot(await accept(a.id)));
    // 已失效（送出後 8 天）
    const d = await submitted();
    await ageSubmitted(d.id, 8);
    asPractice();
    snaps.push(await snapshot(await accept(d.id)));
    expect(snaps[0].status).toBe(409);
    expect(JSON.parse(snaps[0].text)).toMatchObject({ code: 'not_pending' });
    for (const s of snaps.slice(1)) expectSameResponse(s, snaps[0]);
  });

  it('申請對應的業別已不是通過驗證的狀態：409 license_not_verified', async () => {
    const { id } = await submitted();
    await pk.kit.asOwner((db) =>
      db.query(
        `UPDATE registry.practice_licenses SET state = 'lapsed' WHERE kind = 'management' AND entity_id = (SELECT id FROM registry.practice_entities WHERE org_id = $1)`,
        [practice.orgId],
      ),
    );
    // 包租業別仍是通過驗證，所以候選名單不是空的
    asPractice();
    const res = await accept(id);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'license_not_verified' });
  });
});

describe('業者不接受（POST decline）', () => {
  it('業者 admin 不接受：狀態是未接受，屋主收到通知，文字只寫「未接受」', async () => {
    const { id } = await submitted();
    asPractice();
    const res = await decline(id);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ id, status: 'declined', closed_by: 'practice', closed_at: expect.any(String), manager_employment_id: null });
    const notes = await notificationsOf(owner, 'owner');
    expect(notes[0]).toMatchObject({ kind: 'request.declined', title: DECLINED_NOTICE_TITLE, body: DECLINED_NOTICE_BODY('management'), linkPath: `/requests/${id}` });
    expect((await auditOf(practice.orgId)).find((e) => e.action === 'request.decline')?.payload).toEqual({});
  });

  it('不收原因：帶了原因也不讀、不存，屋主讀到的回應沒有原因與管理人員，逐欄位檢查', async () => {
    const { id } = await submitted();
    asPractice();
    expect((await decline(id, { reason: '租金太低，不想接', note: '競業考量' })).status).toBe(200);
    const row = (await pk.registry<Record<string, unknown>>('SELECT * FROM registry.mandate_requests WHERE id = $1', [id]))[0];
    expect(JSON.stringify(row)).not.toContain('租金太低');
    expect(JSON.stringify(row)).not.toContain('競業');

    asOwner();
    const seen = (await readOne(id)).data;
    expect(Object.keys(seen).sort()).toEqual(
      [
        'id', 'kind', 'kind_label', 'status', 'created_at', 'deadline', 'submitted_at', 'withdrawn_at', 'accepted_at', 'closed_at', 'closed_by',
        'practice', 'draft', 'has_transcript', 'confirmed_unit_id', 'unit_ids', 'consent_notice',
      ].sort(),
    );
    expect(seen).toMatchObject({ status: 'declined', accepted_at: null, deadline: null });
    const text = JSON.stringify(seen);
    for (const leak of ['租金太低', '競業', 'manager', 'reason']) expect(text).not.toContain(leak);
    const notes = JSON.stringify(await notificationsOf(owner, 'owner'));
    expect(notes).not.toContain('租金太低');
  });

  it('staff、viewer、屋主組織不能不接受；別家業者 404；不是待業者接受或已失效 409', async () => {
    const { id } = await submitted();
    for (const role of ['staff', 'viewer'] as const) {
      actAsMember(await addMember(practice.orgId, 'practice', role));
      expect((await decline(id)).status).toBe(403);
    }
    asOwner();
    expect((await decline(id)).status).toBe(403);
    asPractice(rival);
    expectSameResponse(await snapshot(await decline(id)), await snapshot(await decline(NO_ID)));
    expect((await decline(id)).status).toBe(404);
    asPractice();
    expect((await decline(id)).status).toBe(200);
    const again = await decline(id);
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ code: 'not_pending' });
    const expired = await submitted();
    await ageSubmitted(expired.id, 8);
    asPractice();
    expect((await decline(expired.id)).status).toBe(409);
  });
});

describe('結束已接受的申請（POST end）', () => {
  async function accepted(): Promise<{ id: string; units: string[]; propertyId: string }> {
    const req = await submitted();
    asPractice();
    expect((await accept(req.id)).status).toBe(200);
    return req;
  }

  it('業者 admin 結束：closed_by 是 practice，屋主看到「業者已結束申請」，稽核寫在業者的鏈', async () => {
    const { id } = await accepted();
    asPractice();
    const res = await end(id);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ id, status: 'ended', closed_by: 'practice', closed_at: expect.any(String) });
    const notes = await notificationsOf(owner, 'owner');
    expect(notes[0]).toMatchObject({ kind: 'request.ended', title: ENDED_BY_PRACTICE_NOTICE_TITLE, body: ENDED_BY_PRACTICE_NOTICE_BODY('management') });
    const practiceAudit = await auditOf(practice.orgId);
    expect(practiceAudit.find((e) => e.action === 'request.end')?.payload).toEqual({});
    expect((await auditOf(owner.orgId)).map((e) => e.action)).not.toContain('request.end');
    asOwner();
    expect((await readOne(id)).data).toMatchObject({ status: 'ended', closed_by: 'practice' });
  });

  it('屋主 admin 結束：closed_by 是 owner，業者看到「屋主已結束申請」，稽核寫在屋主的鏈', async () => {
    const { id } = await accepted();
    asOwner();
    const res = await end(id);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ id, status: 'ended', closed_by: 'owner' });
    const notes = await notificationsOf(practice, 'practice');
    expect(notes[0]).toMatchObject({ kind: 'request.ended', title: ENDED_BY_OWNER_NOTICE_TITLE, body: ENDED_BY_OWNER_NOTICE_BODY('management') });
    expect(JSON.stringify(notes)).not.toContain('王先生');
    expect((await auditOf(owner.orgId)).map((e) => e.action)).toContain('request.end');
    expect((await auditOf(practice.orgId)).map((e) => e.action)).not.toContain('request.end');
  });

  it('屋主 staff 能結束，屋主 viewer 與業者 staff 不能', async () => {
    const a = await accepted();
    actAsMember(await addMember(owner.orgId, 'owner', 'viewer'));
    expect((await end(a.id)).status).toBe(403);
    actAsMember(await addMember(practice.orgId, 'practice', 'staff'));
    expect((await end(a.id)).status).toBe(403);
    actAsMember(await addMember(owner.orgId, 'owner', 'staff'));
    const res = await end(a.id);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ status: 'ended', closed_by: 'owner' });
  });

  it('第三個屋主與別家業者不能結束：404，與不存在的申請逐位元相同', async () => {
    const { id } = await accepted();
    asOwner(stranger);
    const third = await snapshot(await end(id));
    expect(third.status).toBe(404);
    expectSameResponse(third, await snapshot(await end(NO_ID)));
    asPractice(rival);
    expectSameResponse(await snapshot(await end(id)), third);
    asPractice();
    expect((await readOne(id)).data.status).toBe('accepted');
  });

  it('不是已接受的申請與已失效的申請：409 not_pending，回應逐位元相同', async () => {
    const pending = await submitted();
    const declinedReq = await submitted();
    asPractice();
    await decline(declinedReq.id);
    const old = await accepted();
    await ageAccepted(old.id, 31);
    const snaps: Array<Awaited<ReturnType<typeof snapshot>>> = [];
    for (const [who, id] of [[practice, pending.id], [practice, declinedReq.id], [practice, old.id]] as const) {
      asPractice(who);
      snaps.push(await snapshot(await end(id)));
    }
    expect(snaps[0].status).toBe(409);
    expect(JSON.parse(snaps[0].text)).toMatchObject({ code: 'not_pending' });
    for (const s of snaps.slice(1)) expectSameResponse(s, snaps[0]);
    // 已經結束的，兩方再結束都是同一個回應
    const done = await accepted();
    asOwner();
    expect((await end(done.id)).status).toBe(200);
    expectSameResponse(await snapshot(await end(done.id)), snaps[0]);
    asPractice();
    expectSameResponse(await snapshot(await end(done.id)), snaps[0]);
  });

  it('結束之後，屋主能把同一個租賃單位再交給別的申請', async () => {
    const first = await accepted();
    asOwner();
    expect((await end(first.id)).status).toBe(200);
    asPractice();
    const created = await postCreate(jsonRequest('/api/mandate-requests', 'POST', { kind: 'management' }));
    const data = (await json(created)).data;
    const code = (data.link_path as string).replace('/request/', '');
    const { SESSION_COOKIE } = await import('@/lib/auth/config');
    await postClaim(jsonRequest('/x', 'POST', {}, { cookie: `${SESSION_COOKIE}=${owner.token}` }), linkCtx(code));
    asOwner();
    expect((await postSubmit(jsonRequest('/x', 'POST', { unit_ids: first.units }), ctx(data.id))).status).toBe(200);
  });
});

describe('業者在接受前後都讀不到屋主的物件（第二塊才開）', () => {
  it.each(['接受之後', '接受再結束之後'] as const)('%s：物件列表、物件詳情、物件的案件列表都讀不到', async (stage) => {
    const { id, propertyId } = await submitted();
    asPractice();
    expect((await accept(id)).status).toBe(200);
    if (stage === '接受再結束之後') expect((await end(id)).status).toBe(200);
    for (const who of [practice, rival]) {
      asPractice(who);
      expect(((await json(await getProperties())).data as unknown[]).length).toBe(0);
      const detail = await snapshot(await getPropertyOne(jsonRequest('/x', 'GET'), ctx(propertyId)));
      expect(detail.status).toBe(404);
      expectSameResponse(await snapshot(await getPropertyOne(jsonRequest('/x', 'GET'), ctx(NO_ID))), detail);
      const cases = await getCases(jsonRequest(`/api/cases?property_id=${propertyId}`, 'GET') as never);
      const body = await cases.json();
      expect(cases.status === 404 || (Array.isArray(body.data) && body.data.length === 0)).toBe(true);
    }
    // 申請本身沒有屋主的物件資料
    asPractice();
    const text = JSON.stringify((await readOne(id)).data);
    expect(text).not.toContain(propertyId);
    expect(text).not.toContain('和平東路');
    expect(text).not.toContain(owner.orgId);
  });

  it('接受前後，業者與屋主、別家業者之間的呼叫者關係不變，沒有案件成員', async () => {
    const { id } = await submitted();
    const [entity] = await pk.registry<{ id: string }>('SELECT id FROM registry.practice_entities WHERE org_id = $1', [practice.orgId]);
    const relationFrom = (orgId: string) =>
      pk.kit.asOwner(async (db) => {
        await db.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
        try {
          return (await db.query<{ r: string }>('SELECT registry.caller_relation($1) AS r', [entity.id])).rows[0].r;
        } finally {
          await db.query(`SELECT set_config('app.org_id', '', false)`);
        }
      });
    const snapshotRelations = async () => [await relationFrom(owner.orgId), await relationFrom(rival.orgId), await relationFrom(stranger.orgId)];
    const before = await snapshotRelations();
    asPractice();
    expect((await accept(id)).status).toBe(200);
    expect(await snapshotRelations()).toEqual(before);
    expect(before).toEqual(['none', 'none', 'none']);
    const members = await pk.registry(`SELECT 1 FROM org.case_members`);
    expect(members).toEqual([]);
  });
});
