import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRequestContext } from '@/lib/auth/login-flow';
import { newUlid } from '@/lib/pg/ulid';
import { actAsContext, actAsError } from '@/lib/pg/route-test-kit';
import { pdf, setupPracticeKit, type Account, type PracticeKit } from '@/lib/practice-entities/test-kit';
import { Unauthenticated } from '@/lib/request-context';
import { POST as checkRoute } from '../desk/items/[id]/credential-check/route';
import { GET as credentialRoute } from '../desk/credentials/[id]/route';
import { POST as consentRoute } from './consent/route';
import { POST as certificateRoute } from './certificates/route';
import { GET as meRoute } from './me/route';

// MIL-111：執業人員端與審核台證書核對的 route 層。requestContext() 換成 stub，脈絡取自真實的 session。

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));
let kit: PracticeKit;
vi.mock('@/lib/practice-entities/deps', () => ({ defaultFlowDeps: () => kit.deps }));

beforeAll(async () => {
  kit = await setupPracticeKit();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const params = <P extends Record<string, string>>(p: P) => ({ params: Promise.resolve(p) });

async function actAsToken(token: string) {
  actAsContext(await resolveRequestContext(token, new Date(Date.now() + 120_000), 'test'));
}

function certificateRequest(over: Record<string, string> = {}): Request {
  const form = new FormData();
  const fields = { certificateKind: 'rental_housing_manager', certYear: '112', certWord: '內授營', certSerial: '123456', issuedOn: '2024-03-01', validUntil: '2028-03-01', ...over };
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.append('files', new File([pdf().bytes as BlobPart], '證書.pdf', { type: 'application/pdf' }));
  return new Request('http://localhost/api/practitioner/certificates', { method: 'POST', body: form });
}
const consent = (decision: string) =>
  consentRoute(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ decision }) }));

async function registered(email = 'a@example.com'): Promise<Account> {
  const account = await kit.practiceAccount(email);
  await actAsToken(account.token);
  expect((await consent('agree')).status).toBe(201);
  expect((await certificateRoute(certificateRequest())).status).toBe(201);
  return account;
}

describe('本人端 route', () => {
  it('沒登入回 401', async () => {
    actAsError(new Unauthenticated());
    expect((await meRoute()).status).toBe(401);
    expect((await consent('agree')).status).toBe(401);
  });

  it('屋主組織回 403', async () => {
    // 屋主組織的脈絡直接組出，不需要登入
    actAsContext({ kind: 'org', orgId: kit.kit.orgA, orgKind: 'owner', userId: '00000000000000000000000003', partyId: '00000000000000000000000004', role: 'admin', requestId: 't' });
    expect((await meRoute()).status).toBe(403);
    expect((await consent('agree')).status).toBe(403);
  });

  it('告知、登錄、查詢：先看到告知，同意後登錄成功，查詢看到待驗證', async () => {
    const a = await kit.practiceAccount('a@example.com');
    await actAsToken(a.token);
    const before = await json(await meRoute());
    expect(before.data).toMatchObject({ consent: null, notice: { version: 1, legalReview: 'pending' }, canWrite: true, certificates: [] });

    expect((await certificateRoute(certificateRequest())).status).toBe(409);
    expect((await consent('agree')).status).toBe(201);
    const res = await certificateRoute(certificateRequest({ validUntil: '2027-03-01' }));
    expect(res.status).toBe(201);
    expect((await json(res)).data.validUntilHint).toContain('2028-03-01');

    const after = await json(await meRoute());
    expect(after.data.certificates).toMatchObject([{ state: 'pending', phase: 'awaiting_review' }]);
    expect(after.data.myEmployments).toMatchObject([{ state: 'pending' }]);
    expect(after.data.orgEmployments).toMatchObject([{ certificateKind: 'rental_housing_manager', isSelf: true }]);
  });

  it('欄位錯誤回 400 並指出欄位，不留下資料', async () => {
    const a = await kit.practiceAccount('a@example.com');
    await actAsToken(a.token);
    await consent('agree');
    const res = await certificateRoute(certificateRequest({ certSerial: 'abc' }));
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ field: 'certSerial' });
    expect(kit.storeFiles()).toEqual([]);
  });

  it('唯讀成員不能登錄證書（動作表 practitioner.register）', async () => {
    const a = await kit.practiceAccount('a@example.com');
    const viewer = await kit.practiceAccount('v@example.com', { name: '丙公司', taxId: '33333333' });
    // 讓 v 成為 a 組織的唯讀成員
    await kit.registry('INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)', [newUlid(), a.orgId, viewer.userId, 'viewer']);
    actAsContext({ kind: 'org', orgId: a.orgId, orgKind: 'practice', userId: viewer.userId, partyId: viewer.partyId, role: 'viewer', requestId: 't' });
    expect((await consent('agree')).status).toBe(403);
    expect((await certificateRoute(certificateRequest())).status).toBe(403);
    // 唯讀成員仍能看
    expect((await meRoute()).status).toBe(200);
  });

  it('專任阻擋回 409，訊息固定，不含別家資訊', async () => {
    const a = await registered('a@example.com');
    const op = await kit.operatorAccount();
    await actAsToken(op.token);
    const { data } = await json(await (await import('../desk/queue/route')).GET(new Request('http://localhost/api/desk/queue?status=open')));
    for (const type of ['certificate', 'employment']) {
      const item = data.items.find((i: { type: string }) => i.type === type);
      const res = await checkRoute(
        new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ channel: 'resim_manual', querySource: 'resim', result: 'match', note: '', validUntil: '2028-03-01' }) }),
        params({ id: item.id }),
      );
      expect(res.status).toBe(200);
    }
    expect(a.orgId).toBeTruthy();

    const b = await kit.practiceAccount('b@example.com', { name: '乙公司', taxId: '22222222' });
    await actAsToken(b.token);
    await consent('agree');
    const blocked = await certificateRoute(certificateRequest());
    expect(blocked.status).toBe(409);
    const body = await json(blocked);
    expect(body).toMatchObject({ error: '此證號已有在職紀錄', code: 'employment_blocked' });
    expect(JSON.stringify(body)).not.toMatch(/安心代管|12345678/);
  });
});

describe('審核台 route', () => {
  it('非營運者身分回 403', async () => {
    const a = await registered('a@example.com');
    await actAsToken(a.token);
    expect((await credentialRoute(new Request('http://localhost/x'), params({ id: newUlid() }))).status).toBe(403);
    expect((await checkRoute(new Request('http://localhost/x', { method: 'POST', body: '{}' }), params({ id: newUlid() }))).status).toBe(403);
  });

  it('營運者：不存在的項目 404，欄位錯誤 400', async () => {
    await registered('a@example.com');
    const op = await kit.operatorAccount();
    await actAsToken(op.token);
    const post = (id: string, body: unknown) => checkRoute(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }), params({ id }));
    expect((await post(newUlid(), { channel: 'resim_manual', querySource: 'x', result: 'match', validUntil: '2028-03-01' })).status).toBe(404);
    const rows = await kit.registry<{ id: string }>(`SELECT id FROM registry.review_items WHERE type = 'certificate'`);
    const missingDate = await post(rows[0].id, { channel: 'resim_manual', querySource: 'resim', result: 'match' });
    expect(missingDate.status).toBe(400);
    expect(await json(missingDate)).toMatchObject({ field: 'validUntil' });
  });
});
