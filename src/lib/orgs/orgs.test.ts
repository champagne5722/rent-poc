import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_ORG_ID } from '../auth/config';
import { completeLogin, listSessionIdentities, loadLiveSession, requestLoginCode, resolveRequestContext, switchIdentity, type LoginDeps } from '../auth/login-flow';
import { createMockMailer, type MockMailer } from '../mailer/mock-mailer';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { OrgRole } from '../request-context';
import { Unauthenticated } from '../request-context';
import { cancelInvitation, changeRole, inviteMember, listMembers, removeMember, type Actor } from './members';
import { createOwnerOrg, createPracticeOrg } from './onboarding';

// MIL-106：建立組織、邀請成員、移除成員、身分切換、登入落地。連線是 PGlite 的 app_rw，權限與 RLS 都生效。

let kit: RouteDb;
let mailer: MockMailer;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  mailer = createMockMailer();
});

const T0 = new Date('2026-11-09T10:00:00Z');
const env = { PLATFORM_OPERATOR_EMAILS: 'ops@example.com' };
let clock = 0;
function deps(over: Partial<LoginDeps> = {}): LoginDeps {
  // 每次登入往後走 2 分鐘，避開同一 email 每分鐘 1 次的限制
  clock += 120_000;
  return { now: new Date(T0.getTime() + clock), secret: 'test-secret', mailer, env, ...over };
}

async function login(email: string) {
  const d = deps();
  expect(await requestLoginCode(email, d)).toEqual({ status: 'sent' });
  const code = mailer.sent.at(-1)!.text.match(/\d{6}/)![0];
  const result = await completeLogin(email, code, d);
  if (result.status !== 'ok') throw new Error('登入失敗');
  return result;
}

const now = () => new Date(T0.getTime() + clock);

async function auditActions(orgId: string): Promise<string[]> {
  return withTx({ kind: 'org', orgId }, async (tx) => (await tx.query<{ action: string }>('SELECT action FROM audit.events ORDER BY seq')).rows.map((r) => r.action));
}

/** 新帳號登入，直接建一個屋主組織。回傳 token 與組織 ID。 */
async function ownerAccount(email: string, orgName = '屋主組織') {
  const { token } = await login(email);
  expect(await createOwnerOrg(token, { name: orgName }, { now: now() })).toEqual({ status: 'ok', landing: '/owner' });
  const session = (await loadLiveSession(token, now()))!;
  if (session.identity?.kind !== 'org') throw new Error('建完組織後 session 應該是組織身分');
  return { token, orgId: session.identity.orgId, userId: session.userId, partyId: session.partyId };
}

async function actorOf(token: string): Promise<Actor> {
  const rc = await resolveRequestContext(token, now(), 'test');
  if (rc.kind !== 'org') throw new Error('不是組織身分');
  return { orgId: rc.orgId, userId: rc.userId, role: rc.role };
}

/** 以某位成員的身分，在其組織脈絡內做事。 */
async function asMember<T>(token: string, fn: (tx: Parameters<typeof inviteMember>[0], actor: Actor) => Promise<T>): Promise<T> {
  const actor = await actorOf(token);
  const rc = await resolveRequestContext(token, now(), 'test');
  if (rc.kind !== 'org') throw new Error('不是組織身分');
  return withTx({ kind: 'org', orgId: rc.orgId, partyId: rc.partyId }, (tx) => fn(tx, actor));
}

describe('第一次登入：沒有任何身分', () => {
  it('新帳號登入後 session 沒有身分，requestContext 丟 no_identity，登入回應導向建組織', async () => {
    const result = await login('new@example.com');
    expect(result.identity).toBeNull();
    await expect(resolveRequestContext(result.token, now(), 'r')).rejects.toMatchObject({ reason: 'no_identity' });
  });

  it('「我是屋主」：建 owner 組織，帳號是 admin，session 切到新組織，落地 /owner', async () => {
    const { token } = await login('owner@example.com');
    expect(await createOwnerOrg(token, { name: '王小明的屋主組織' }, { now: now() })).toEqual({ status: 'ok', landing: '/owner' });

    const rc = await resolveRequestContext(token, now(), 'r');
    expect(rc).toMatchObject({ kind: 'org', orgKind: 'owner', role: 'admin' });
    const org = await kit.asOwner(async (db) => (await db.query<{ name: string; kind: string }>('SELECT name, kind FROM control.orgs WHERE id = $1', [(rc as { orgId: string }).orgId])).rows[0]);
    expect(org).toEqual({ name: '王小明的屋主組織', kind: 'owner' });
  });

  it('建組織寫 org.create 與 member.grant，進新組織自己的鏈', async () => {
    const { token, orgId } = await ownerAccount('owner@example.com');
    expect(token).toBeTruthy();
    // 登入事件發生在組織建立之前，寫在平台鏈；組織自己的鏈從 org.create 開始
    expect(await auditActions(orgId)).toEqual(['org.create', 'member.grant']);
  });

  it('名稱空白被拒，不建組織', async () => {
    const { token } = await login('owner@example.com');
    expect(await createOwnerOrg(token, { name: '  ' }, { now: now() })).toMatchObject({ status: 'invalid', field: 'name' });
    expect((await loadLiveSession(token, now()))!.identity).toBeNull();
  });

  it('沒有登入或 session 已到期：unauthenticated', async () => {
    expect(await createOwnerOrg(undefined, { name: 'x' }, { now: now() })).toEqual({ status: 'unauthenticated' });
    const { token } = await login('owner@example.com');
    const later = new Date(now().getTime() + 8 * 24 * 60 * 60 * 1000);
    expect(await createOwnerOrg(token, { name: 'x' }, { now: later })).toEqual({ status: 'unauthenticated' });
  });

  it('已經有身分的帳號不能再用這條路建組織，也不會多出組織', async () => {
    const { token } = await ownerAccount('owner@example.com');
    expect(await createOwnerOrg(token, { name: '第二個' }, { now: now() })).toEqual({ status: 'has_identity' });
    const count = await kit.asOwner(async (db) => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM control.orgs WHERE name = '第二個'")).rows[0].n);
    expect(count).toBe(0);
  });

  it('同一個 session 並發建兩次組織，只會有一個成功', async () => {
    const { token } = await login('owner@example.com');
    const results = await Promise.all([
      createOwnerOrg(token, { name: 'A' }, { now: now() }),
      createOwnerOrg(token, { name: 'B' }, { now: now() }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['has_identity', 'ok']);
  });
});

const practiceForm = (over: Record<string, unknown> = {}) => ({
  name: '安心代管有限公司',
  taxId: '12345678',
  entityType: 'company',
  kinds: ['management'],
  ...over,
});

async function registry<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return kit.asOwner(async (db) => (await db.query<T>(sql, params)).rows);
}

describe('「我是經理人」：建執業主體組織與待驗證的業別', () => {
  it('建 practice 組織與待驗證的執業主體，業別是 pending，排一筆 license 審核項目', async () => {
    const { token } = await login('mgr@example.com');
    expect(await createPracticeOrg(token, practiceForm({ kinds: ['management', 'brokerage'] }), { now: now() })).toEqual({ status: 'ok', landing: '/' });

    const rc = await resolveRequestContext(token, now(), 'r');
    expect(rc).toMatchObject({ kind: 'org', orgKind: 'practice', role: 'admin' });
    const orgId = (rc as { orgId: string }).orgId;

    const entities = await registry<{ tax_id: string; name: string; entity_type: string; org_id: string }>('SELECT tax_id, name, entity_type, org_id FROM registry.practice_entities');
    expect(entities).toEqual([{ tax_id: '12345678', name: '安心代管有限公司', entity_type: 'company', org_id: orgId }]);
    const licenses = await registry<{ kind: string; state: string }>('SELECT kind, state FROM registry.practice_licenses ORDER BY kind');
    expect(licenses).toEqual([
      { kind: 'brokerage', state: 'pending' },
      { kind: 'management', state: 'pending' },
    ]);
    const items = await registry<{ type: string; status: string }>('SELECT type, status FROM registry.review_items ORDER BY type');
    expect(items).toEqual([
      { type: 'license', status: 'open' },
      { type: 'license', status: 'open' },
    ]);
    expect(await auditActions(orgId)).toEqual(['org.create', 'member.grant', 'practice_entity.register']);
  });

  it.each([['management'], ['master_lease']])('個體商號選 %s：被拒（company_required），不建組織、不建執業主體', async (kind) => {
    const { token } = await login('mgr@example.com');
    const result = await createPracticeOrg(token, practiceForm({ entityType: 'firm', kinds: [kind] }), { now: now() });
    expect(result).toMatchObject({ status: 'invalid', field: 'kinds', code: 'company_required' });
    expect(await registry('SELECT 1 FROM registry.practice_entities')).toHaveLength(0);
    expect((await loadLiveSession(token, now()))!.identity).toBeNull();
  });

  it('個體商號只選經紀可以', async () => {
    const { token } = await login('mgr@example.com');
    expect(await createPracticeOrg(token, practiceForm({ entityType: 'firm', kinds: ['brokerage'] }), { now: now() })).toMatchObject({ status: 'ok' });
  });

  it('第二個組織認領同一統編：不建新的執業主體，產生 entity_claim 審核項目，回應與第一個完全相同', async () => {
    const first = await login('first@example.com');
    const second = await login('second@example.com');
    const r1 = await createPracticeOrg(first.token, practiceForm(), { now: now() });
    const r2 = await createPracticeOrg(second.token, practiceForm({ name: '搶先登錄有限公司', kinds: ['management', 'master_lease'] }), { now: now() });
    expect(r2).toEqual(r1);

    const entities = await registry<{ name: string; org_id: string }>('SELECT name, org_id FROM registry.practice_entities');
    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe('安心代管有限公司');

    const claims = await registry<{ subject_id: string; payload: Record<string, unknown> }>("SELECT subject_id, payload FROM registry.review_items WHERE type = 'entity_claim'");
    expect(claims).toHaveLength(1);
    expect(claims[0].subject_id).toBeTruthy();
    const secondRc = await resolveRequestContext(second.token, now(), 'r');
    expect(claims[0].payload).toMatchObject({ tax_id: '12345678', name: '搶先登錄有限公司', kinds: ['management', 'master_lease'], claimant_org_id: (secondRc as { orgId: string }).orgId });

    // 認領方的組織存在，帳號是 admin，但沒有登錄執業主體；稽核事件只寫認領方自己的鏈
    expect(secondRc).toMatchObject({ orgKind: 'practice', role: 'admin' });
    // 稽核匯出看不出統編已被登錄：兩個組織的事件完全一樣
    const firstRc = (await resolveRequestContext(first.token, now(), 'r')) as { orgId: string };
    expect(await auditActions((secondRc as { orgId: string }).orgId)).toEqual(['org.create', 'member.grant', 'practice_entity.register']);
    expect(await auditActions(firstRc.orgId)).toEqual(await auditActions((secondRc as { orgId: string }).orgId));
  });

  it('認領方的回應、稽核事件與錯誤都不含別的組織的名稱與 ID', async () => {
    const first = await login('first@example.com');
    const second = await login('second@example.com');
    await createPracticeOrg(first.token, practiceForm({ name: '被認領的獨特公司名' }), { now: now() });
    const firstOrg = ((await resolveRequestContext(first.token, now(), 'r')) as { orgId: string }).orgId;
    const result = await createPracticeOrg(second.token, practiceForm({ name: '認領方' }), { now: now() });
    const secondOrg = ((await resolveRequestContext(second.token, now(), 'r')) as { orgId: string }).orgId;
    const leaked = JSON.stringify([result, await withTx({ kind: 'org', orgId: secondOrg }, async (tx) => (await tx.query('SELECT payload FROM audit.events')).rows)]);
    expect(leaked).not.toContain('被認領的獨特公司名');
    expect(leaked).not.toContain(firstOrg);
  });

  it('registry 函式必須在 p_org_id 的組織脈絡內呼叫', async () => {
    await expect(
      withTx({ kind: 'control' }, (tx) =>
        tx.query(`SELECT registry.claim_practice_entity($1, '99999999', 'x', 'company', ARRAY['management'], $2, ARRAY[$3], ARRAY[$4, $5])`, [
          newUlid(), newUlid(), newUlid(), newUlid(), newUlid(),
        ]),
      ),
    ).rejects.toThrow(/組織脈絡/);
  });
});

describe('邀請與成員管理', () => {
  it('admin 邀請 email，被邀請者登入後成為成員，帳號不必事先存在', async () => {
    const admin = await ownerAccount('admin@example.com');
    const invited = await asMember(admin.token, (tx, actor) => inviteMember(tx, actor, { email: 'Staff@Example.com ', role: 'staff', now: now() }));
    expect(invited).toMatchObject({ status: 'invited', email: 'staff@example.com' });

    const login2 = await login('staff@example.com');
    expect(login2.identity).toEqual({ kind: 'org', orgId: admin.orgId });
    expect(login2.landing).toBe('/owner');
    const rc = await resolveRequestContext(login2.token, now(), 'r');
    expect(rc).toMatchObject({ kind: 'org', orgId: admin.orgId, role: 'staff' });

    const members = await asMember(admin.token, (tx, actor) => listMembers(tx, actor));
    expect(members.members.map((m) => [m.email, m.role])).toEqual([['admin@example.com', 'admin'], ['staff@example.com', 'staff']]);
    expect(members.invitations).toEqual([]);
    expect(await auditActions(admin.orgId)).toEqual(expect.arrayContaining(['member.invite', 'member.grant']));
  });

  it('邀請已經有帳號的人：登入後多一個身分，原本的身分還在', async () => {
    const adminA = await ownerAccount('a@example.com', 'A 組織');
    const other = await ownerAccount('b@example.com', 'B 組織');
    await asMember(adminA.token, (tx, actor) => inviteMember(tx, actor, { email: 'b@example.com', role: 'viewer', now: now() }));
    const again = await login('b@example.com');
    const list = await listSessionIdentities(again.token, now());
    expect(list!.options.map((o) => o.label)).toEqual(['B 組織', 'A 組織']);
    expect(again.identity).toEqual({ kind: 'org', orgId: other.orgId });
  });

  it('staff 與 viewer 不能邀請、改角色、移除、撤銷邀請；也看不到待處理的邀請', async () => {
    const admin = await ownerAccount('admin@example.com');
    await asMember(admin.token, (tx, actor) => inviteMember(tx, actor, { email: 'staff@example.com', role: 'staff', now: now() }));
    await asMember(admin.token, (tx, actor) => inviteMember(tx, actor, { email: 'viewer@example.com', role: 'viewer', now: now() }));
    const staff = await login('staff@example.com');
    const viewer = await login('viewer@example.com');
    await asMember(admin.token, (tx, actor) => inviteMember(tx, actor, { email: 'pending@example.com', role: 'staff', now: now() }));

    for (const who of [staff, viewer]) {
      const out = await asMember(who.token, async (tx, actor) => ({
        invite: await inviteMember(tx, actor, { email: 'x@example.com', role: 'staff', now: now() }),
        role: await changeRole(tx, actor, { userId: admin.userId, role: 'viewer' }),
        remove: await removeMember(tx, actor, { userId: admin.userId }),
        cancel: await cancelInvitation(tx, actor, '0000000000000000000000000Z'),
        list: await listMembers(tx, actor),
      }));
      expect([out.invite.status, out.role.status, out.remove.status, out.cancel.status]).toEqual(['forbidden', 'forbidden', 'forbidden', 'forbidden']);
      expect(out.list.members).toHaveLength(3);
      expect(out.list.invitations).toEqual([]);
    }
  });

  it('邀請的錯誤情況：email 格式、角色、已是成員、重複邀請', async () => {
    const admin = await ownerAccount('admin@example.com');
    const invite = (email: unknown, role: unknown = 'staff') => asMember(admin.token, (tx, actor) => inviteMember(tx, actor, { email, role, now: now() }));
    expect((await invite('nope')).status).toBe('invalid_email');
    expect((await invite('a@example.com', 'owner')).status).toBe('invalid_role');
    expect((await invite('ADMIN@example.com')).status).toBe('already_member');
    expect((await invite('new@example.com')).status).toBe('invited');
    expect((await invite('new@example.com', 'viewer')).status).toBe('already_invited');
  });

  it('撤銷邀請後，該 email 登入不會成為成員；已接受的邀請撤銷不到', async () => {
    const admin = await ownerAccount('admin@example.com');
    const invited = await asMember(admin.token, (tx, actor) => inviteMember(tx, actor, { email: 'late@example.com', role: 'staff', now: now() }));
    if (invited.status !== 'invited') throw new Error('應該邀請成功');
    expect((await asMember(admin.token, (tx, actor) => cancelInvitation(tx, actor, invited.invitationId))).status).toBe('cancelled');
    expect((await login('late@example.com')).identity).toBeNull();
    expect((await asMember(admin.token, (tx, actor) => cancelInvitation(tx, actor, invited.invitationId))).status).toBe('not_found');
    expect(await auditActions(admin.orgId)).toContain('member.invite_cancel');
  });

  it('別的組織的邀請 ID 撤銷不到（control 表不掛 RLS，靠明確的 org_id 條件）', async () => {
    const a = await ownerAccount('a@example.com', 'A');
    const b = await ownerAccount('b@example.com', 'B');
    const invited = await asMember(a.token, (tx, actor) => inviteMember(tx, actor, { email: 'x@example.com', role: 'staff', now: now() }));
    if (invited.status !== 'invited') throw new Error('應該邀請成功');
    expect((await asMember(b.token, (tx, actor) => cancelInvitation(tx, actor, invited.invitationId))).status).toBe('not_found');
  });

  it('改角色：寫 member.role_change；下一個請求就看到新角色', async () => {
    const admin = await ownerAccount('admin@example.com');
    await asMember(admin.token, (tx, actor) => inviteMember(tx, actor, { email: 'staff@example.com', role: 'staff', now: now() }));
    const staff = await login('staff@example.com');
    const staffUser = (await loadLiveSession(staff.token, now()))!.userId;
    expect((await asMember(admin.token, (tx, actor) => changeRole(tx, actor, { userId: staffUser, role: 'viewer' }))).status).toBe('changed');
    expect(await resolveRequestContext(staff.token, now(), 'r')).toMatchObject({ role: 'viewer' });
    expect((await asMember(admin.token, (tx, actor) => changeRole(tx, actor, { userId: staffUser, role: 'viewer' }))).status).toBe('unchanged');
    expect((await asMember(admin.token, (tx, actor) => changeRole(tx, actor, { userId: staffUser, role: 'boss' }))).status).toBe('invalid_role');
    expect(await auditActions(admin.orgId)).toContain('member.role_change');
  });

  it('組織至少留一位 admin：最後一位 admin 不能降級或被移除；有第二位 admin 就可以', async () => {
    const admin = await ownerAccount('admin@example.com');
    expect((await asMember(admin.token, (tx, actor) => changeRole(tx, actor, { userId: admin.userId, role: 'staff' }))).status).toBe('last_admin');
    expect((await asMember(admin.token, (tx, actor) => removeMember(tx, actor, { userId: admin.userId }))).status).toBe('last_admin');

    await asMember(admin.token, (tx, actor) => inviteMember(tx, actor, { email: 'second@example.com', role: 'admin', now: now() }));
    await login('second@example.com');
    expect((await asMember(admin.token, (tx, actor) => changeRole(tx, actor, { userId: admin.userId, role: 'staff' }))).status).toBe('changed');
  });

  it('兩位 admin 同時互相降級，不會把組織降到沒有 admin', async () => {
    const first = await ownerAccount('first@example.com');
    await asMember(first.token, (tx, actor) => inviteMember(tx, actor, { email: 'second@example.com', role: 'admin', now: now() }));
    const second = await login('second@example.com');
    const secondUser = (await loadLiveSession(second.token, now()))!.userId;
    const results = await Promise.all([
      asMember(first.token, (tx, actor) => changeRole(tx, actor, { userId: secondUser, role: 'viewer' })),
      asMember(second.token, (tx, actor) => changeRole(tx, actor, { userId: first.userId, role: 'viewer' })),
    ]);
    const admins = await registry<{ n: number }>("SELECT count(*)::int AS n FROM control.org_memberships WHERE role = 'admin' AND org_id = $1", [first.orgId]);
    expect(admins[0].n).toBeGreaterThanOrEqual(1);
    expect(results.filter((r) => r.status === 'changed').length).toBeLessThanOrEqual(1 + 1);
  });

  it('移除成員：同交易刪該組織身分的 session，對方下一個請求被拒，並寫 member.revoke', async () => {
    const admin = await ownerAccount('admin@example.com');
    await asMember(admin.token, (tx, actor) => inviteMember(tx, actor, { email: 'staff@example.com', role: 'staff', now: now() }));
    const staff = await login('staff@example.com');
    const staffUser = (await loadLiveSession(staff.token, now()))!.userId;
    expect(await resolveRequestContext(staff.token, now(), 'r')).toMatchObject({ role: 'staff' });

    const removed = await asMember(admin.token, (tx, actor) => removeMember(tx, actor, { userId: staffUser }));
    expect(removed).toEqual({ status: 'removed', sessionsRevoked: 1 });

    await expect(resolveRequestContext(staff.token, now(), 'r')).rejects.toBeInstanceOf(Unauthenticated);
    expect(await loadLiveSession(staff.token, now())).toBeNull();
    expect(await auditActions(admin.orgId)).toContain('member.revoke');
    const members = await asMember(admin.token, (tx, actor) => listMembers(tx, actor));
    expect(members.members.map((m) => m.email)).toEqual(['admin@example.com']);
  });

  it('移除成員只刪該組織身分的 session，該帳號其他身分的 session 不動', async () => {
    const a = await ownerAccount('a@example.com', 'A');
    const b = await ownerAccount('b@example.com', 'B');
    await asMember(a.token, (tx, actor) => inviteMember(tx, actor, { email: 'b@example.com', role: 'staff', now: now() }));
    const bAgain = await login('b@example.com'); // 預設身分是 B 自己的組織
    const bUser = (await loadLiveSession(bAgain.token, now()))!.userId;
    const inA = await switchIdentity(bAgain.token, { kind: 'org', orgId: a.orgId }, now());
    expect(inA.status).toBe('ok');
    // B 另外有一個 B 組織身分的 session（建組織時的那個）
    expect(await resolveRequestContext(b.token, now(), 'r')).toMatchObject({ orgId: b.orgId });

    const removed = await asMember(a.token, (tx, actor) => removeMember(tx, actor, { userId: bUser }));
    expect(removed).toEqual({ status: 'removed', sessionsRevoked: 1 });
    await expect(resolveRequestContext(bAgain.token, now(), 'r')).rejects.toBeInstanceOf(Unauthenticated);
    expect(await resolveRequestContext(b.token, now(), 'r')).toMatchObject({ orgId: b.orgId });
  });

  it('別的組織的成員 ID 移除不到、改不到', async () => {
    const a = await ownerAccount('a@example.com', 'A');
    const b = await ownerAccount('b@example.com', 'B');
    expect((await asMember(a.token, (tx, actor) => removeMember(tx, actor, { userId: b.userId }))).status).toBe('not_found');
    expect((await asMember(a.token, (tx, actor) => changeRole(tx, actor, { userId: b.userId, role: 'viewer' }))).status).toBe('not_found');
    expect(await resolveRequestContext(b.token, now(), 'r')).toMatchObject({ orgId: b.orgId, role: 'admin' });
  });

  it('稽核事件的 payload 不放 email', async () => {
    const admin = await ownerAccount('admin@example.com');
    await asMember(admin.token, (tx, actor) => inviteMember(tx, actor, { email: 'secret.person@example.com', role: 'staff', now: now() }));
    await login('secret.person@example.com');
    const payloads = await withTx({ kind: 'org', orgId: admin.orgId }, async (tx) => (await tx.query('SELECT payload FROM audit.events')).rows);
    expect(JSON.stringify(payloads)).not.toContain('secret.person');
    expect(JSON.stringify(payloads)).not.toContain('admin@example.com');
  });
});

describe('身分切換器', () => {
  it('只有一種身分：選項只有一個（畫面據此不顯示切換器）', async () => {
    const owner = await ownerAccount('owner@example.com', '我的屋主組織');
    const list = await listSessionIdentities(owner.token, now());
    expect(list!.options).toHaveLength(1);
    expect(list!.current).toMatchObject({ kind: 'owner', label: '我的屋主組織' });
  });

  it('多種身分：只列帳號真的有的，先加入的組織在前，平台營運者最後', async () => {
    const first = await ownerAccount('first@example.com', '第一個組織');
    const second = await ownerAccount('second@example.com', '第二個組織');
    await asMember(second.token, (tx, actor) => inviteMember(tx, actor, { email: 'ops@example.com', role: 'staff', now: now() }));
    await asMember(first.token, (tx, actor) => inviteMember(tx, actor, { email: 'ops@example.com', role: 'viewer', now: now() }));
    const again = await login('ops@example.com'); // PLATFORM_OPERATOR_EMAILS 的帳號，邀請在同一次登入轉成成員
    const list = await listSessionIdentities(again.token, now());
    const labels = list!.options.map((o) => o.label);
    // 同一次登入加入的組織，建立時間相同，彼此的順序不保證；平台營運者一定在最後
    expect(labels.slice(0, 2).sort()).toEqual(['第一個組織', '第二個組織']);
    expect(labels[2]).toBe('平台營運者');
    expect(labels).toHaveLength(3);
  });

  it('沒有承租人身分的帳號，選項沒有「承租人」', async () => {
    const owner = await ownerAccount('owner@example.com');
    const list = await listSessionIdentities(owner.token, now());
    expect(list!.options.some((o) => o.kind === 'party')).toBe(false);
  });

  it('平台營運者由 PLATFORM_OPERATOR_EMAILS 建立，切換器出現「平台營運者」，切過去後 requestContext 是 operator', async () => {
    const result = await login('ops@example.com');
    expect(result.identity).toEqual({ kind: 'operator' });
    const list = await listSessionIdentities(result.token, now());
    expect(list!.options.map((o) => o.label)).toEqual(['平台營運者']);
    expect(await resolveRequestContext(result.token, now(), 'r')).toMatchObject({ kind: 'operator' });
  });

  it('切換：寫進 session，下一個請求的脈絡是新身分；落地依身分決定', async () => {
    const a = await ownerAccount('a@example.com', 'A 屋主');
    await asMember(a.token, (tx, actor) => inviteMember(tx, actor, { email: 'ops@example.com', role: 'viewer', now: now() }));
    const ops = await login('ops@example.com');
    expect(ops.landing).toBe('/'); // 屋主組織加平台營運者，不是只有屋主身分
    expect(await switchIdentity(ops.token, { kind: 'operator' }, now())).toEqual({ status: 'ok', landing: '/' });
    expect(await resolveRequestContext(ops.token, now(), 'r')).toMatchObject({ kind: 'operator' });
    expect(await switchIdentity(ops.token, { kind: 'org', orgId: a.orgId }, now())).toEqual({ status: 'ok', landing: '/owner' });
    expect(await resolveRequestContext(ops.token, now(), 'r')).toMatchObject({ kind: 'org', orgId: a.orgId, role: 'viewer' });
  });

  it('不能切到沒有的身分：別的組織、承租人、平台營運者、格式錯誤，都是 not_available，session 不變', async () => {
    const a = await ownerAccount('a@example.com', 'A');
    const b = await ownerAccount('b@example.com', 'B');
    for (const target of [
      { kind: 'org', orgId: b.orgId },
      { kind: 'org' },
      { kind: 'org', orgId: 'nope' },
      { kind: 'party' },
      { kind: 'operator' },
      { kind: 'platform' },
      {},
    ]) {
      expect(await switchIdentity(a.token, target, now())).toEqual({ status: 'not_available' });
    }
    expect(await resolveRequestContext(a.token, now(), 'r')).toMatchObject({ orgId: a.orgId });
  });

  it('沒有登入不能切換，也列不出身分', async () => {
    expect(await switchIdentity(undefined, { kind: 'operator' }, now())).toEqual({ status: 'unauthenticated' });
    expect(await listSessionIdentities('x'.repeat(40), now())).toBeNull();
  });

  it('平台營運者不能以組織身分切到平台組織', async () => {
    const result = await login('ops@example.com');
    expect(await switchIdentity(result.token, { kind: 'org', orgId: PLATFORM_ORG_ID }, now())).toEqual({ status: 'not_available' });
  });
});

describe('登入落地', () => {
  const landing = async (email: string) => (await login(email)).landing;

  it('只有屋主身分的帳號落到 /owner', async () => {
    await ownerAccount('owner@example.com');
    expect(await landing('owner@example.com')).toBe('/owner');
  });

  it('經理人落到工作台', async () => {
    const { token } = await login('mgr@example.com');
    await createPracticeOrg(token, practiceForm(), { now: now() });
    expect(await landing('mgr@example.com')).toBe('/');
  });

  it('平台營運者落到工作台', async () => {
    expect(await landing('ops@example.com')).toBe('/');
  });

  it('同時是屋主與經理人的帳號落到工作台', async () => {
    const owner = await ownerAccount('both@example.com', '屋主');
    const mgr = await login('mgr@example.com');
    await createPracticeOrg(mgr.token, practiceForm(), { now: now() });
    await asMember(owner.token, (tx, actor) => inviteMember(tx, actor, { email: 'mgr@example.com', role: 'staff', now: now() }));
    expect(await landing('mgr@example.com')).toBe('/');
  });
});

describe('角色型別', () => {
  it('組織角色只有 admin、staff、viewer', async () => {
    const roles: OrgRole[] = ['admin', 'staff', 'viewer'];
    const admin = await ownerAccount('admin@example.com');
    for (const role of roles) {
      const r = await asMember(admin.token, (tx, actor) => inviteMember(tx, actor, { email: `${role}-invitee@example.com`, role, now: now() }));
      expect(r.status).toBe('invited');
    }
  });
});
