import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { actAsContext, actAsError } from '@/lib/pg/route-test-kit';
import { Unauthenticated } from '@/lib/request-context';
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
  verifyLicenses,
  type Account,
  type OwnerAccount,
  type PracticeKit,
} from '@/lib/mandate-requests/test-kit';
import { POST as postProperty } from '../properties/route';
import { GET as getLink } from './link/[code]/route';
import { GET as getOne } from './[id]/route';
import { GET as getList, POST as postCreate } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));
let pk: PracticeKit;
vi.mock('@/lib/file-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/file-store')>()),
  getFileStore: () => pk.store,
}));

// MIL-206 資料段第 1 步：業者產生連結、登入前的連結頁、業者讀自己的申請。
// 主要 seam：route handler 直接呼叫，配 PGlite 的 app_rw 連線，業者與屋主用真實的登入流程建立。

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
const create = (body: unknown) => postCreate(jsonRequest('/api/mandate-requests', 'POST', body));
const codeOf = (linkPath: string) => linkPath.replace('/request/', '');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function createOk(body: Record<string, unknown> = { kind: 'management' }) {
  const res = await create(body);
  expect(res.status).toBe(201);
  const data = (await json(res)).data;
  return { ...data, code: codeOf(data.link_path) as string };
}

const rows = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => pk.registry<T>(sql, params);
const rowOf = async (id: string) => (await rows<Record<string, unknown>>('SELECT * FROM registry.mandate_requests WHERE id = $1', [id]))[0];

/** 把申請在資料庫裡的時間往前推，模擬時間經過。 */
async function ageRequest(id: string, days: number) {
  await pk.kit.asOwner((db) =>
    db.query(
      `UPDATE registry.mandate_requests
          SET created_at = created_at - ($2 || ' days')::interval, link_expires_at = link_expires_at - ($2 || ' days')::interval
        WHERE id = $1`,
      [id, String(days)],
    ),
  );
}

/** 直接改資料庫，模擬屋主端的動作（第 2 步才有 route）。 */
async function bindTo(id: string, orgId: string, claimedAt = new Date()) {
  await pk.kit.asOwner((db) => db.query('UPDATE registry.mandate_requests SET owner_org_id = $2, claimed_at = $3 WHERE id = $1', [id, orgId, claimedAt]));
}

describe('POST /api/mandate-requests：業者產生連結', () => {
  it('對應業別已驗證的業者產生連結：201，待屋主確認，7 天後失效，碼只在這次回應出現', async () => {
    const data = await createOk({ kind: 'management', draft: sampleDraft() });
    expect(data).toMatchObject({ kind: 'management', kind_label: '委託管理申請', status: 'pending_owner', submitted_at: null, unit_count: null });
    expect(data.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(data.deadline).getTime() - new Date(data.created_at).getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(data.draft.name).toBe('大安區溫馨兩房');
  });

  it('資料庫只存碼的 SHA-256，整列找不到明碼', async () => {
    const data = await createOk({ kind: 'management', draft: sampleDraft() });
    const row = await rowOf(data.id);
    expect(row.code_hash).toBe(sha256(data.code));
    expect(JSON.stringify(row)).not.toContain(data.code);
    // 之後所有讀取都拿不到碼
    expect(JSON.stringify(await json(await getOne(jsonRequest('/x', 'GET'), ctx(data.id))))).not.toContain(data.code);
    expect(JSON.stringify(await json(await getList()))).not.toContain(data.code);
  });

  it('沒有代填資料的連結同樣 7 天失效', async () => {
    const data = await createOk({ kind: 'management' });
    expect(data.draft).toBeNull();
    expect(new Date(data.deadline).getTime() - new Date(data.created_at).getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('每個連結的碼都不同', async () => {
    const a = await createOk();
    const b = await createOk();
    expect(a.code).not.toBe(b.code);
  });

  it('住宅包租申請需要包租業別已驗證：只有代管業別已驗證時，包租申請回 403，什麼都沒寫', async () => {
    const onlyManagement = await verifiedPractice(pk, 'practice-b@example.com', { kinds: ['management', 'master_lease'], verified: ['management'] });
    actAsAccount(onlyManagement, 'practice');
    const res = await create({ kind: 'master_lease' });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: 'license_not_verified' });
    expect(await rows('SELECT id FROM registry.mandate_requests')).toEqual([]);
    expect((await create({ kind: 'management' })).status).toBe(201);
  });

  it('業別還在待驗證時不能產生連結', async () => {
    const pending = await verifiedPractice(pk, 'pending@example.com', { name: '新公司', kinds: ['management'], verified: [] });
    actAsAccount(pending, 'practice');
    expect((await create({ kind: 'management' })).status).toBe(403);
    await verifyLicenses(pk, pending.orgId, ['management']);
    expect((await create({ kind: 'management' })).status).toBe(201);
  });

  it('屋主的組織與唯讀成員不能產生連結', async () => {
    actAsAccount(owner, 'owner');
    expect((await create({ kind: 'management' })).status).toBe(403);
    actAsAccount(practice, 'practice', 'viewer');
    expect((await create({ kind: 'management' })).status).toBe(403);
    expect(await rows('SELECT id FROM registry.mandate_requests')).toEqual([]);
  });

  it('沒有登入回 401', async () => {
    actAsError(new Unauthenticated());
    expect((await create({ kind: 'management' })).status).toBe(401);
  });

  it('種類與代填資料格式錯誤回 400，什麼都沒寫', async () => {
    expect((await create({ kind: 'brokerage' })).status).toBe(400);
    expect((await create({})).status).toBe(400);
    expect((await create({ kind: 'management', draft: { name: '缺地址' } })).status).toBe(400);
    expect((await create({ kind: 'management', draft: sampleDraft({ anchor: undefined }) })).status).toBe(400);
    expect(await rows('SELECT id FROM registry.mandate_requests')).toEqual([]);
  });

  it('產生連結不寄任何 email', async () => {
    const before = pk.mailer.sent.length;
    await createOk({ kind: 'management', draft: sampleDraft() });
    expect(pk.mailer.sent.length).toBe(before);
  });

  it('代填的建號與別的組織已登錄的相同時，業者的回應與不相同時沒有差異', async () => {
    const key = sampleDraft().anchor;
    const normalize = (data: Record<string, any>) => ({ ...data, id: 'X', code: 'X', created_at: 'X', deadline: 'X', link_path: 'X' }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const before = await createOk({ kind: 'management', draft: sampleDraft({ anchor: key }) });
    // 另一個屋主組織先登錄同一個建號，成立後再代填一次
    actAsAccount(owner, 'owner');
    const registered = await postProperty(jsonRequest('/api/properties', 'POST', sampleDraft({ anchor: key })));
    expect(registered.status).toBe(201);
    actAsAccount(practice, 'practice');
    const after = await createOk({ kind: 'management', draft: sampleDraft({ anchor: key }) });
    expect(normalize(after)).toEqual(normalize(before));
  });

  it('代填資料不建錨點、不佔建號：資料庫的錨點與審核台沒有新增', async () => {
    const countAnchors = async () => (await rows<{ n: string }>('SELECT count(*)::text AS n FROM registry.anchors'))[0].n;
    const countItems = async () => (await rows<{ n: string }>('SELECT count(*)::text AS n FROM registry.review_items'))[0].n;
    const [anchors, items] = [await countAnchors(), await countItems()];
    await createOk({ kind: 'management', draft: sampleDraft() });
    expect([await countAnchors(), await countItems()]).toEqual([anchors, items]);
    expect(await rows('SELECT 1 FROM registry.verified_ownership_keys')).toEqual([]);
  });
});

describe('GET /api/mandate-requests/link/[code]：登入前的連結頁', () => {
  const link = async (code: string) => snapshot(await getLink(jsonRequest('/x', 'GET'), linkCtx(code)));

  it('有效的連結回業者名稱、統編、已驗證的業別與申請種類，沒有別的', async () => {
    const data = await createOk({ kind: 'management', draft: sampleDraft() });
    actAsError(new Unauthenticated());
    const res = await getLink(jsonRequest('/x', 'GET'), linkCtx(data.code));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Object.keys(body)).toEqual(['data']);
    expect(Object.keys(body.data).sort()).toEqual(['expires_at', 'kind', 'kind_label', 'practice']);
    expect(body.data).toMatchObject({
      kind: 'management',
      kind_label: '委託管理申請',
      practice: { name: expect.stringContaining('安心代管有限公司'), tax_id: expect.stringMatching(/^\d{8}$/), verified_kinds: ['management', 'master_lease'] },
    });
    expect(Object.keys(body.data.practice).sort()).toEqual(['name', 'tax_id', 'verified_kinds']);
    // 代填資料不出現在登入前的回應
    const text = JSON.stringify(body);
    expect(text).not.toContain('溫馨兩房');
    expect(text).not.toContain('和平東路');
    expect(text).not.toContain('buildingNo');
  });

  it('住宅包租申請顯示住宅包租申請', async () => {
    const data = await createOk({ kind: 'master_lease' });
    actAsError(new Unauthenticated());
    expect((await json(await getLink(jsonRequest('/x', 'GET'), linkCtx(data.code)))).data.kind_label).toBe('住宅包租申請');
  });

  it('無效的連結：格式錯誤、查無此碼、已過期、已送出、已收回、業別失效、已被別的屋主組織綁定，回應逐位元相同', async () => {
    const expired = await createOk();
    await ageRequest(expired.id, 8);
    const submitted = await createOk();
    const withdrawn = await createOk();
    const claimedByOther = await createOk();
    await pk.kit.asOwner((db) =>
      db.query(
        `UPDATE registry.mandate_requests SET status = 'pending_practice', owner_org_id = $2, claimed_at = now(), submitted_at = now() WHERE id = $1`,
        [submitted.id, owner.orgId],
      ),
    );
    await pk.kit.asOwner((db) =>
      db.query(
        `UPDATE registry.mandate_requests SET status = 'withdrawn', owner_org_id = $2, claimed_at = now(), submitted_at = now(), withdrawn_at = now() WHERE id = $1`,
        [withdrawn.id, owner.orgId],
      ),
    );
    // 業別失效：另外建一個住宅包租申請，再讓包租業別失效
    const lapsedKind = await createOk({ kind: 'master_lease' });
    await pk.kit.asOwner((db) => db.query(`UPDATE registry.practice_licenses SET state = 'lapsed' WHERE kind = 'master_lease'`));
    await bindTo(claimedByOther.id, pk.kit.orgA);

    // 登入的是另一個屋主組織（orgB 是 kit 的屋主組織）：已被 orgA 綁定的連結對它無效
    actAsContext({ kind: 'org', orgId: pk.kit.orgB, orgKind: 'owner', userId: owner.userId, partyId: owner.partyId, role: 'admin', requestId: 't' });
    const invalid = await link(claimedByOther.code);
    expect(invalid.status).toBe(404);
    expect(JSON.parse(invalid.text)).toEqual({ error: '連結無效或已失效，請向業者索取新的連結' });
    const unknown = await link('A'.repeat(43));
    const malformed = await link('not-a-valid-code');
    actAsError(new Unauthenticated());
    const cases = [
      unknown,
      malformed,
      await link(expired.code),
      await link(submitted.code),
      await link(withdrawn.code),
      await link(lapsedKind.code),
    ];
    for (const c of cases) expectSameResponse(c, invalid);
  });

  it('綁定判斷只對屋主組織生效：登入前、業者自己、綁定的屋主組織都看到有效的連結，業者探不出屋主有沒有開過', async () => {
    const unclaimed = await createOk();
    const claimed = await createOk();
    await bindTo(claimed.id, pk.kit.orgA);
    const body = async () => {
      const a = await snapshot(await getLink(jsonRequest('/x', 'GET'), linkCtx(unclaimed.code)));
      const b = await snapshot(await getLink(jsonRequest('/x', 'GET'), linkCtx(claimed.code)));
      return { a, b };
    };
    const normalizeExpiry = (s: { text: string }) => JSON.parse(s.text).data.practice;
    // 業者自己打開連結：已綁定與未綁定看到的內容相同
    actAsAccount(practice, 'practice');
    const asPractice = await body();
    expect(asPractice.a.status).toBe(200);
    expect(asPractice.b.status).toBe(200);
    expect(normalizeExpiry(asPractice.a)).toEqual(normalizeExpiry(asPractice.b));
    // 登入前：同樣
    actAsError(new Unauthenticated());
    const anonymous = await body();
    expect(anonymous.b.status).toBe(200);
    // 綁定的屋主組織：有效
    actAsContext({ kind: 'org', orgId: pk.kit.orgA, orgKind: 'owner', userId: owner.userId, partyId: owner.partyId, role: 'admin', requestId: 't' });
    expect((await body()).b.status).toBe(200);
  });

  it('連結頁每次回應都不快取', async () => {
    const data = await createOk();
    actAsError(new Unauthenticated());
    expect((await link(data.code)).headers['cache-control']).toBe('no-store');
    expect((await link('A'.repeat(43))).headers['cache-control']).toBe('no-store');
  });
});

describe('業者讀自己的申請', () => {
  it('列表只含自己的申請，最新的在前', async () => {
    const first = await createOk();
    const second = await createOk({ kind: 'master_lease' });
    const other = await verifiedPractice(pk, 'practice-b@example.com');
    actAsAccount(other, 'practice');
    const theirs = await createOk();
    const otherList = (await json(await getList())).data.map((r: { id: string }) => r.id);
    expect(otherList).toEqual([theirs.id]);
    actAsAccount(practice, 'practice');
    const list = (await json(await getList())).data.map((r: { id: string }) => r.id);
    expect(list).toEqual([second.id, first.id]);
  });

  it('別的業者讀這份申請、不存在的申請、格式錯誤的 ID，回應逐位元相同', async () => {
    const mine = await createOk({ kind: 'management', draft: sampleDraft() });
    const other = await verifiedPractice(pk, 'practice-b@example.com');
    actAsAccount(other, 'practice');
    const read = async (id: string) => snapshot(await getOne(jsonRequest('/x', 'GET'), ctx(id)));
    const foreign = await read(mine.id);
    expect(foreign.status).toBe(404);
    expectSameResponse(await read('01ARZ3NDEKTSV4RRFFQ69G5FAV'), foreign);
    expectSameResponse(await read('not-an-id'), foreign);
    expect(foreign.text).not.toContain('溫馨兩房');
  });

  it('沒綁定的屋主組織讀別人的申請：回 404，與不存在的申請逐位元相同；列表是空的', async () => {
    const mine = await createOk({ kind: 'management', draft: sampleDraft() });
    actAsAccount(owner, 'owner');
    const read = async (id: string) => snapshot(await getOne(jsonRequest('/x', 'GET'), ctx(id)));
    const foreign = await read(mine.id);
    expect(foreign.status).toBe(404);
    expectSameResponse(await read('01ARZ3NDEKTSV4RRFFQ69G5FAV'), foreign);
    expect(foreign.text).not.toContain('溫馨兩房');
    expect((await json(await getList())).data).toEqual([]);
  });

  it('沒人打開、屋主已綁定連結，業者讀到的申請逐位元相同（除了每份申請自己的 ID、碼與時間）', async () => {
    const draft = sampleDraft();
    const untouched = await createOk({ kind: 'management', draft });
    const claimed = await createOk({ kind: 'management', draft });
    await bindTo(claimed.id, owner.orgId);
    const shape = async (id: string) => {
      const one = (await json(await getOne(jsonRequest('/x', 'GET'), ctx(id)))).data;
      return { ...one, id: 'X', created_at: 'X', deadline: 'X' };
    };
    expect(await shape(claimed.id)).toEqual(await shape(untouched.id));
    const list = (await json(await getList())).data as Array<Record<string, unknown>>;
    const norm = (r: Record<string, unknown>) => ({ ...r, id: 'X', created_at: 'X', deadline: 'X' });
    expect(norm(list.find((r) => r.id === claimed.id)!)).toEqual(norm(list.find((r) => r.id === untouched.id)!));
  });

  it('失效後：狀態是 expired，代填資料不再回傳，列表順手把資料與檔案清掉', async () => {
    const data = await createOk({ kind: 'management', draft: sampleDraft() });
    await ageRequest(data.id, 8);
    const one = (await json(await getOne(jsonRequest('/x', 'GET'), ctx(data.id)))).data;
    expect(one).toMatchObject({ status: 'expired', draft: null, deadline: null });
    expect((await rowOf(data.id)).draft).not.toBeNull();
    const list = (await json(await getList())).data;
    expect(list[0]).toMatchObject({ status: 'expired', draft: null });
    expect((await rowOf(data.id)).draft).toBeNull();
  });

  it('唯讀成員可以讀', async () => {
    const data = await createOk();
    actAsAccount(practice, 'practice', 'viewer');
    expect((await getOne(jsonRequest('/x', 'GET'), ctx(data.id))).status).toBe(200);
    expect((await getList()).status).toBe(200);
  });
});

