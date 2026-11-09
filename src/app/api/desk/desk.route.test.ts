import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRequestContext } from '@/lib/auth/login-flow';
import { actAsContext, actAsError } from '@/lib/pg/route-test-kit';
import { pdf, setupPracticeKit, type Account, type PracticeKit } from '@/lib/practice-entities/test-kit';
import { Unauthenticated } from '@/lib/request-context';
import { GET as evidenceRoute } from './evidence/[id]/route';
import { POST as checkRoute } from './items/[id]/check/route';
import { POST as claimRoute } from './items/[id]/claim/route';
import { GET as itemRoute } from './items/[id]/route';
import { GET as queueRoute } from './queue/route';
import { GET as lookupRoute } from '../practice-entities/lookup/route';
import { GET as registrationRoute } from '../practice/registration/route';
import { POST as submitRoute } from '../practice/licenses/route';

// MIL-109：審核台與執業主體端的 route 層。requestContext() 換成 stub，脈絡取自真實的 session。

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));
// production 相依（general 的 FileStore、寄信 adapter）換成測試用的本機版本
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

function submitForm(over: { kind?: string; permitNo?: string; files?: File[] } = {}): Request {
  const form = new FormData();
  form.set('kind', over.kind ?? 'management');
  form.set('permitNo', over.permitNo ?? '北市租管字第 123 號');
  for (const file of over.files ?? [new File([pdf().bytes as BlobPart], '許可函.pdf', { type: 'application/pdf' })]) form.append('files', file);
  return new Request('http://localhost/api/practice/licenses', { method: 'POST', body: form });
}

const check = (id: string, body: unknown) =>
  checkRoute(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }), params({ id }));

const matchBody = (over: Record<string, unknown> = {}) => ({
  channel: 'gcis_manual',
  querySource: '商工登記公示資料查詢',
  result: 'match',
  businessItemCodes: ['H706011'],
  registrationStatus: '核准設立',
  ...over,
});

async function practiceSubmitted(email = 'a@example.com'): Promise<{ account: Account; itemId: string }> {
  const account = await kit.practiceAccount(email);
  await actAsToken(account.token);
  expect((await submitRoute(submitForm())).status).toBe(201);
  const itemId = (await kit.registry<{ id: string }>("SELECT id FROM registry.review_items WHERE type = 'license' AND status = 'open'"))[0].id;
  return { account, itemId };
}

async function actAsOperator() {
  const op = await kit.operatorAccount();
  await actAsToken(op.token);
  return op;
}

describe('執業主體端', () => {
  it('沒登入回 401', async () => {
    actAsError(new Unauthenticated());
    expect((await registrationRoute()).status).toBe(401);
    expect((await submitRoute(submitForm())).status).toBe(401);
  });

  it('GET /api/practice/registration：各業別的進度；送件後變待核對', async () => {
    const account = await kit.practiceAccount('a@example.com');
    await actAsToken(account.token);
    const before = await json(await registrationRoute());
    expect(before.data.canSubmit).toBe(true);
    expect(before.data.registration.licenses[0]).toMatchObject({ kind: 'management', phase: 'not_submitted' });
    await submitRoute(submitForm());
    expect((await json(await registrationRoute())).data.registration.licenses[0].phase).toBe('awaiting_review');
  });

  it('POST /api/practice/licenses：欄位錯誤回 400 並指出欄位；檔案不是 PDF 或圖片回 400', async () => {
    const account = await kit.practiceAccount('a@example.com');
    await actAsToken(account.token);
    const noFile = await submitRoute(submitForm({ files: [] }));
    expect(noFile.status).toBe(400);
    expect((await json(noFile)).field).toBe('files');
    const html = await submitRoute(submitForm({ files: [new File(['<html>'], 'x.pdf', { type: 'application/pdf' })] }));
    expect(html.status).toBe(400);
    expect((await json(html)).field).toBe('files');
    expect((await submitRoute(submitForm({ kind: 'unknown' }))).status).toBe(400);
  });

  it('商號送代管回 400 company_required', async () => {
    const account = await kit.practiceAccount('a@example.com', { entityType: 'firm', kinds: ['brokerage'] });
    await actAsToken(account.token);
    const res = await submitRoute(submitForm({ kind: 'management' }));
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ field: 'kind', code: 'company_required' });
  });

  it('已驗證的業別再送件回 409', async () => {
    const { account, itemId } = await practiceSubmitted();
    await actAsOperator();
    expect((await check(itemId, matchBody())).status).toBe(200);
    await actAsToken(account.token);
    expect((await submitRoute(submitForm())).status).toBe(409);
  });
});

describe('執業主體端的角色把關（authorize）', () => {
  it('唯讀成員看得到登錄進度，送件被拒，什麼都沒寫入；屋主組織看登錄進度回 403', async () => {
    const account = await kit.practiceAccount('a@example.com');
    actAsContext({ kind: 'org', orgId: account.orgId, orgKind: 'practice', userId: account.userId, partyId: account.partyId, role: 'viewer', requestId: 'test' });
    const view = await registrationRoute();
    expect(view.status).toBe(200);
    expect((await json(view)).data.canSubmit).toBe(false);
    expect((await submitRoute(submitForm())).status).toBe(403);
    expect(await kit.registry('SELECT 1 FROM vault.credential_evidence')).toHaveLength(0);

    actAsContext({ kind: 'org', orgId: account.orgId, orgKind: 'owner', userId: account.userId, partyId: account.partyId, role: 'admin', requestId: 'test' });
    expect((await registrationRoute()).status).toBe(403);
  });
});

describe('審核台的身分把關', () => {
  it('沒登入 401；組織身分（執業主體、屋主）一律 403：佇列、詳情、核對、認領、證據檔', async () => {
    const { account, itemId } = await practiceSubmitted();
    const someId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

    actAsError(new Unauthenticated());
    expect((await queueRoute(new Request('http://localhost/api/desk/queue'))).status).toBe(401);
    expect((await check(itemId, matchBody())).status).toBe(401);

    await actAsToken(account.token);
    expect((await queueRoute(new Request('http://localhost/api/desk/queue'))).status).toBe(403);
    expect((await itemRoute(new Request('http://localhost/x'), params({ id: itemId }))).status).toBe(403);
    expect((await check(itemId, matchBody())).status).toBe(403);
    expect(
      (await claimRoute(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ decision: 'keep_registrant', note: 'x' }) }), params({ id: itemId }))).status,
    ).toBe(403);
    expect((await evidenceRoute(new Request('http://localhost/x'), params({ id: someId }))).status).toBe(403);
    // 什麼都沒寫入
    expect(await kit.registry('SELECT 1 FROM registry.credential_checks')).toHaveLength(0);
  });
});

describe('審核台', () => {
  it('GET /api/desk/queue：列待核對項目與等待時間；status 不合法回 400', async () => {
    await practiceSubmitted();
    await actAsOperator();
    const res = await queueRoute(new Request('http://localhost/api/desk/queue'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({ type: 'license', status: 'open', summary: { kind: 'management' } });
    expect(typeof body.data.items[0].waitingMs).toBe('number');
    expect((await queueRoute(new Request('http://localhost/api/desk/queue?status=all'))).status).toBe(400);
  });

  it('GET /api/desk/items/:id：詳情含業別、證據檔中繼資料；找不到與格式不合都回 404', async () => {
    const { itemId } = await practiceSubmitted();
    await actAsOperator();
    const res = await itemRoute(new Request('http://localhost/x'), params({ id: itemId }));
    const body = await json(res);
    expect(body.data.license).toMatchObject({ kind: 'management', permitNo: '北市租管字第 123 號' });
    expect(body.data.evidence).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('object_key');
    expect((await itemRoute(new Request('http://localhost/x'), params({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }))).status).toBe(404);
    expect((await itemRoute(new Request('http://localhost/x'), params({ id: 'not-a-ulid' }))).status).toBe(404);
  });

  it('POST check：只有 H703100 回 422 並列出缺少的項目；相符回 200，業別已驗證', async () => {
    const { account, itemId } = await practiceSubmitted();
    await actAsOperator();
    const denied = await check(itemId, matchBody({ businessItemCodes: ['H703100'] }));
    expect(denied.status).toBe(422);
    expect((await json(denied)).reasons).toEqual([
      { code: 'missing_business_item', kind: 'management', message: '缺少營業項目 H706011', missing: 'H706011' },
    ]);
    const ok = await check(itemId, matchBody());
    expect(ok.status).toBe(200);
    expect((await json(ok)).data).toMatchObject({ from: 'pending', to: 'verified', result: 'match' });
    await actAsToken(account.token);
    expect((await json(await registrationRoute())).data.registration.licenses[0].state).toBe('verified');
    // 已結案再核對回 409
    await actAsOperator();
    expect((await check(itemId, matchBody())).status).toBe(409);
  });

  it('POST check：表單欄位錯誤回 400 並指出欄位；不符沒寫理由回 400；不是 JSON 回 400', async () => {
    const { itemId } = await practiceSubmitted();
    await actAsOperator();
    const bad = await check(itemId, matchBody({ channel: 'gcis_api' }));
    expect(bad.status).toBe(400);
    expect((await json(bad)).field).toBe('channel');
    const noNote = await check(itemId, matchBody({ result: 'mismatch' }));
    expect(noNote.status).toBe(400);
    expect((await json(noNote)).field).toBe('note');
    expect((await checkRoute(new Request('http://localhost/x', { method: 'POST', body: 'x' }), params({ id: itemId }))).status).toBe(400);
  });

  it('POST check 不符：執業主體在進度頁看到補件原因', async () => {
    const { account, itemId } = await practiceSubmitted();
    await actAsOperator();
    expect((await check(itemId, matchBody({ result: 'mismatch', note: '字號與公司名稱不符' }))).status).toBe(200);
    await actAsToken(account.token);
    expect((await json(await registrationRoute())).data.registration.licenses[0]).toMatchObject({
      phase: 'needs_resubmission', lastNote: '字號與公司名稱不符',
    });
  });

  it('GET evidence：回原始檔案與安全標頭；相符刪除後回 404', async () => {
    const { itemId } = await practiceSubmitted();
    const evidenceId = (await kit.registry<{ id: string }>('SELECT id FROM vault.credential_evidence'))[0].id;
    await actAsOperator();
    const res = await evidenceRoute(new Request('http://localhost/x'), params({ id: evidenceId }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(new TextDecoder().decode(await res.arrayBuffer())).toContain('%PDF');
    await check(itemId, matchBody());
    expect((await evidenceRoute(new Request('http://localhost/x'), params({ id: evidenceId }))).status).toBe(404);
  });

  it('POST claim：判定歸屬；缺理由回 400', async () => {
    await practiceSubmitted('a@example.com');
    const b = await kit.practiceAccount('b@example.com');
    await actAsToken(b.token);
    await submitRoute(submitForm({ permitNo: '認領方字號' }));
    const claimId = (await kit.registry<{ id: string }>("SELECT id FROM registry.review_items WHERE type = 'entity_claim'"))[0].id;
    await actAsOperator();
    const call = (body: unknown) => claimRoute(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }), params({ id: claimId }));
    expect((await call({ decision: 'to_claimant', note: '' })).status).toBe(400);
    expect((await call({ decision: 'to_claimant', note: '認領方提供登記證明' })).status).toBe(200);
    expect((await call({ decision: 'to_claimant', note: '再判一次' })).status).toBe(409);
  });
});

describe('GET /api/practice-entities/lookup', () => {
  it('以 ID 清單查詢；格式不合的 ID 當作查無；組織脈絡才能查', async () => {
    const a = await kit.practiceAccount('a@example.com');
    const id = (await kit.registry<{ id: string }>('SELECT id FROM registry.practice_entities'))[0].id;
    await actAsToken(a.token);
    const res = await lookupRoute(new NextRequest(`http://localhost/api/practice-entities/lookup?ids=${id},bad,01ARZ3NDEKTSV4RRFFQ69G5FAV`));
    expect(res.status).toBe(200);
    expect((await json(res)).data.entities).toEqual([
      { id, name: '安心代管有限公司', title: '租賃住宅代管業者', hasVerifiedLicense: false, licenses: [{ kind: 'management', title: '租賃住宅代管業者', state: 'pending' }] },
    ]);
    expect((await lookupRoute(new NextRequest('http://localhost/api/practice-entities/lookup?ids='))).status).toBe(200);
    expect((await lookupRoute(new NextRequest('http://localhost/api/practice-entities/lookup?ids=x&businessType=bad'))).status).toBe(400);
    actAsError(new Unauthenticated());
    expect((await lookupRoute(new NextRequest(`http://localhost/api/practice-entities/lookup?ids=${id}`))).status).toBe(401);
  });
});
