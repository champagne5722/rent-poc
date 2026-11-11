import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { actAsError } from '@/lib/pg/route-test-kit';
import { Unauthenticated } from '@/lib/request-context';
import {
  actAsAccount,
  cookieOf,
  expectSameResponse,
  json,
  jsonRequest,
  ownerAccount,
  sampleDraft,
  setupPracticeKit,
  snapshot,
  verifiedPractice,
  type Account,
  type OwnerAccount,
  type PracticeKit,
} from '@/lib/mandate-requests/test-kit';
import { GET as getOwnership } from '../properties/[id]/ownership/route';
import { GET as getPropertyOne } from '../properties/[id]/route';
import { GET as getProperties, POST as postProperty } from '../properties/route';
import { POST as postClaim } from './link/[code]/claim/route';
import { GET as getLink } from './link/[code]/route';
import { POST as postConfirm } from './[id]/confirm-draft/route';
import { GET as getOne } from './[id]/route';
import { POST as postSubmit } from './[id]/submit/route';
import { GET as getTranscript, POST as postTranscript } from './[id]/transcript/route';
import { GET as getList, POST as postCreate } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));
let pk: PracticeKit;
vi.mock('@/lib/file-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/file-store')>()),
  getFileStore: () => pk.store,
}));

// MIL-206 驗收 17 的四項滲透測試，加上主控要檢查的幾個安全點：
//   1. 沒有被接受的申請時，業者讀不到屋主的物件
//   2. 連結頁在登入前不回任何物件資料
//   3. 別的業者讀不到這筆申請
//   4. 別的組織讀不到申請的租賃單位
// 申請被接受的路徑屬 MIL-210，這裡只涵蓋接受之前的每個階段：產生連結、綁定、確認代填資料、送出、收回、失效。

beforeAll(async () => {
  pk = await setupPracticeKit();
}, 60_000);
afterAll(() => pk.close());

let practice: Account;
let rival: Account;
let owner: OwnerAccount;
let stranger: OwnerAccount;
beforeEach(async () => {
  await pk.reset();
  practice = await verifiedPractice(pk, 'practice-a@example.com');
  rival = await verifiedPractice(pk, 'practice-b@example.com');
  owner = await ownerAccount(pk, 'wang@example.com', '王先生');
  stranger = await ownerAccount(pk, 'lee@example.com', '李先生');
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const linkCtx = (code: string) => ({ params: Promise.resolve({ code }) });
const NO_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const asPractice = (a: Account = practice) => actAsAccount(a, 'practice');
const asOwner = (o: OwnerAccount = owner) => actAsAccount(o, 'owner');

const ADDRESS = '台北市大安區和平東路二段 100 號 3 樓';
const NAME = '大安區溫馨兩房';

async function createRequest(kind = 'management') {
  asPractice();
  const draft = sampleDraft({ name: NAME, address: ADDRESS });
  const res = await postCreate(jsonRequest('/api/mandate-requests', 'POST', { kind, draft }));
  expect(res.status).toBe(201);
  const data = (await json(res)).data;
  return { id: data.id as string, code: (data.link_path as string).replace('/request/', ''), draft };
}

/** 一路走到指定階段，回傳各階段會用到的 ID。 */
async function walkTo(stage: 'created' | 'claimed' | 'confirmed' | 'submitted' | 'withdrawn' | 'expired') {
  const req = await createRequest();
  let propertyId: string | null = null;
  let unitId: string | null = null;
  if (stage !== 'created') {
    expect((await postClaim(jsonRequest('/x', 'POST', {}, cookieOf(owner.token)), linkCtx(req.code))).status).toBe(200);
  }
  if (['confirmed', 'submitted', 'withdrawn'].includes(stage)) {
    asOwner();
    const confirmed = (await json(await postConfirm(jsonRequest('/x', 'POST', { consent: 'agree' }), ctx(req.id)))).data;
    propertyId = confirmed.id;
    unitId = confirmed.rental_unit_id;
  }
  if (['submitted', 'withdrawn'].includes(stage)) {
    asOwner();
    expect((await postSubmit(jsonRequest('/x', 'POST', { unit_ids: [unitId] }), ctx(req.id))).status).toBe(200);
  }
  if (stage === 'withdrawn') {
    const { POST } = await import('./[id]/withdraw/route');
    asOwner();
    expect((await POST(jsonRequest('/x', 'POST'), ctx(req.id))).status).toBe(200);
  }
  if (stage === 'expired') {
    await pk.kit.asOwner((db) =>
      db.query(`UPDATE registry.mandate_requests SET created_at = created_at - interval '8 days', link_expires_at = link_expires_at - interval '8 days' WHERE id = $1`, [req.id]),
    );
  }
  return { ...req, propertyId, unitId };
}

const STAGES = ['created', 'claimed', 'confirmed', 'submitted', 'withdrawn', 'expired'] as const;

describe('滲透 1：沒有被接受的申請時，業者讀不到屋主的物件', () => {
  it.each(STAGES)('階段 %s：業者的物件列表、物件詳情、所有權文件與申請本身都沒有屋主的物件', async (stage) => {
    const { id, propertyId, unitId } = await walkTo(stage);
    for (const who of [practice, rival]) {
      asPractice(who);
      expect(((await json(await getProperties())).data as unknown[]).length).toBe(0);
      if (propertyId) {
        const detail = await snapshot(await getPropertyOne(jsonRequest('/x', 'GET'), ctx(propertyId)));
        expect(detail.status).toBe(404);
        expectSameResponse(await snapshot(await getPropertyOne(jsonRequest('/x', 'GET'), ctx(NO_ID))), detail);
        const ownership = await snapshot(await getOwnership(jsonRequest('/x', 'GET') as never, ctx(propertyId)));
        expect(ownership.status).toBe(404);
        expectSameResponse(await snapshot(await getOwnership(jsonRequest('/x', 'GET') as never, ctx(NO_ID))), ownership);
      }
    }
    // 業者讀自己的申請：沒有屋主的組織、租賃單位 ID、物件名稱
    asPractice();
    const own = JSON.stringify((await json(await getOne(jsonRequest('/x', 'GET'), ctx(id)))).data);
    if (unitId) expect(own).not.toContain(unitId);
    expect(own).not.toContain(owner.orgId);
    expect(own).not.toContain('王先生');
    expect(own).not.toContain('wang@example.com');
    if (stage === 'submitted' || stage === 'withdrawn') {
      expect(own).not.toContain(ADDRESS);
      expect(own).not.toContain(NAME);
    }
  });
});

describe('滲透 2：連結頁在登入前不回任何物件資料', () => {
  it.each(STAGES)('階段 %s：登入前的連結頁沒有代填資料、屋主資料與租賃單位', async (stage) => {
    const { code, unitId, propertyId } = await walkTo(stage);
    actAsError(new Unauthenticated());
    const res = await getLink(jsonRequest('/x', 'GET'), linkCtx(code));
    const text = await res.text();
    for (const forbidden of [ADDRESS, NAME, '和平東路', 'buildingNo', owner.orgId, owner.partyId, '王先生', 'wang@example.com', 'draft', 'transcript']) {
      expect(text).not.toContain(forbidden);
    }
    if (unitId) expect(text).not.toContain(unitId);
    if (propertyId) expect(text).not.toContain(propertyId);
    if (res.status === 200) {
      expect(Object.keys(JSON.parse(text).data).sort()).toEqual(['expires_at', 'kind', 'kind_label', 'practice']);
      expect(Object.keys(JSON.parse(text).data.practice).sort()).toEqual(['name', 'tax_id', 'verified_kinds']);
    }
  });

  it('送出、收回、失效後，登入前的連結頁與不存在的碼逐位元相同', async () => {
    actAsError(new Unauthenticated());
    const unknown = await snapshot(await getLink(jsonRequest('/x', 'GET'), linkCtx('A'.repeat(43))));
    for (const stage of ['submitted', 'withdrawn', 'expired'] as const) {
      const { code } = await walkTo(stage);
      actAsError(new Unauthenticated());
      expectSameResponse(await snapshot(await getLink(jsonRequest('/x', 'GET'), linkCtx(code))), unknown);
    }
  });
});

describe('滲透 3：別的業者讀不到這筆申請', () => {
  it.each(STAGES)('階段 %s：別的業者的 GET、列表、代傳謄本與讀原檔都拿不到，回應與不存在的申請逐位元相同', async (stage) => {
    const { id } = await walkTo(stage);
    asPractice(rival);
    const form = () => {
      const f = new FormData();
      f.set('claimed_owner', '王大明');
      f.set('acquired_at', '2020-01-01');
      f.set('file', new File([new TextEncoder().encode('%PDF-1.7\nx')], 'x.pdf', { type: 'application/pdf' }));
      return f;
    };
    const attempt = async (target: string) => ({
      get: await snapshot(await getOne(jsonRequest('/x', 'GET'), ctx(target))),
      file: await snapshot(await getTranscript(jsonRequest('/x', 'GET'), ctx(target))),
      attach: await snapshot(await postTranscript(new (await import('next/server')).NextRequest('http://localhost/x', { method: 'POST', body: form() }), ctx(target))),
    });
    const real = await attempt(id);
    const none = await attempt(NO_ID);
    expect(real.get.status).toBe(404);
    expectSameResponse(real.get, none.get);
    expectSameResponse(real.file, none.file);
    expectSameResponse(real.attach, none.attach);
    expect(((await json(await getList())).data as unknown[]).length).toBe(0);
    // 送出與收回、確認也不是它的事
    asOwner(stranger);
    expect(((await json(await getList())).data as unknown[]).length).toBe(0);
  });
});

describe('滲透 4：別的組織讀不到申請的租賃單位', () => {
  it('送出之後，別的業者、別的屋主組織、營運資料都讀不到這份申請的租賃單位', async () => {
    const { id, unitId, propertyId } = await walkTo('submitted');
    asPractice(rival);
    expect(JSON.stringify(await json(await getOne(jsonRequest('/x', 'GET'), ctx(id))))).not.toContain(unitId!);
    asOwner(stranger);
    const read = await snapshot(await getOne(jsonRequest('/x', 'GET'), ctx(id)));
    expectSameResponse(read, await snapshot(await getOne(jsonRequest('/x', 'GET'), ctx(NO_ID))));
    expect(read.text).not.toContain(unitId!);
    expect(((await json(await getProperties())).data as unknown[]).length).toBe(0);
    expect((await getPropertyOne(jsonRequest('/x', 'GET'), ctx(propertyId!))).status).toBe(404);
    // 別的屋主組織拿這個租賃單位 ID 送出自己的申請：與不存在的租賃單位逐位元相同
    const other = await createRequest();
    expect((await postClaim(jsonRequest('/x', 'POST', {}, cookieOf(stranger.token)), linkCtx(other.code))).status).toBe(200);
    asOwner(stranger);
    const foreign = await snapshot(await postSubmit(jsonRequest('/x', 'POST', { unit_ids: [unitId] }), ctx(other.id)));
    const missing = await snapshot(await postSubmit(jsonRequest('/x', 'POST', { unit_ids: [NO_ID] }), ctx(other.id)));
    expect(foreign.status).toBe(404);
    expectSameResponse(foreign, missing);
  });

  it('租賃單位被進行中的申請佔用時，屋主自己看到的拒絕只有固定訊息，不含業者的名稱', async () => {
    const { unitId } = await walkTo('submitted');
    const second = await createRequest('master_lease');
    expect((await postClaim(jsonRequest('/x', 'POST', {}, cookieOf(owner.token)), linkCtx(second.code))).status).toBe(200);
    asOwner();
    const own = await postSubmit(jsonRequest('/x', 'POST', { unit_ids: [unitId] }), ctx(second.id));
    expect(own.status).toBe(409);
    expect(await json(own)).toMatchObject({ code: 'units_unavailable' });
    expect(JSON.stringify(await json(await postSubmit(jsonRequest('/x', 'POST', { unit_ids: [unitId] }), ctx(second.id))))).not.toContain('安心代管');
  });

  it('資料庫層：app_rw 直接查申請的租賃單位表被拒，每個組織都一樣', async () => {
    const { withTx } = await import('@/lib/pg/database');
    for (const orgId of [practice.orgId, rival.orgId, owner.orgId, stranger.orgId]) {
      await expect(withTx({ kind: 'org', orgId }, (tx) => tx.query('SELECT * FROM registry.mandate_request_units'))).rejects.toThrow(/permission denied/);
      await expect(withTx({ kind: 'org', orgId }, (tx) => tx.query('SELECT * FROM registry.mandate_requests'))).rejects.toThrow(/permission denied/);
    }
  });

  it('租賃單位登錄在屋主自己的組織，別的屋主組織登錄同一個建號，回應與沒有人登錄時相同', async () => {
    const key = sampleDraft().anchor;
    asOwner();
    const first = await postProperty(jsonRequest('/api/properties', 'POST', sampleDraft({ anchor: key })));
    asOwner(stranger);
    const second = await postProperty(jsonRequest('/api/properties', 'POST', sampleDraft({ anchor: key })));
    expect(second.status).toBe(first.status);
    expect(Object.keys((await json(second)).data).sort()).toEqual(Object.keys((await json(first)).data).sort());
  });
});
