import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTx } from '@/lib/pg/database';
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
import { GET as getProperties } from '../properties/route';
import { POST as postClaim } from './link/[code]/claim/route';
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

// MIL-206 資料段第 3 步：業者代傳謄本、屋主同意個資告知才轉成屋主組織的謄本、原檔的保存與刪除、讀取稽核。

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
const PDF = new TextEncoder().encode('%PDF-1.7\n謄本內容');
const asPractice = (a: Account = practice) => actAsAccount(a, 'practice');
const asOwner = (o: OwnerAccount = owner) => actAsAccount(o, 'owner');

async function createOk(body: Record<string, unknown> = { kind: 'management', draft: sampleDraft() }) {
  asPractice();
  const res = await postCreate(jsonRequest('/api/mandate-requests', 'POST', body));
  expect(res.status).toBe(201);
  const data = (await json(res)).data;
  return { ...data, code: (data.link_path as string).replace('/request/', '') } as Record<string, any> & { id: string; code: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface UploadOptions {
  file?: { bytes: Uint8Array; name: string; type: string } | null;
  claimedOwner?: string | null;
  acquiredAt?: string | null;
}
function uploadForm(options: UploadOptions = {}): FormData {
  const form = new FormData();
  const { claimedOwner = '王大明', acquiredAt = '2020-01-01' } = options;
  const file = options.file === undefined ? { bytes: PDF, name: '謄本.pdf', type: 'application/pdf' } : options.file;
  if (claimedOwner !== null) form.set('claimed_owner', claimedOwner);
  if (acquiredAt !== null) form.set('acquired_at', acquiredAt);
  if (file) form.set('file', new File([file.bytes as BlobPart], file.name, { type: file.type }));
  return form;
}
const upload = (id: string, options: UploadOptions = {}) =>
  postTranscript(new NextRequest('http://localhost/x', { method: 'POST', body: uploadForm(options) }), ctx(id));
const read = (id: string) => getTranscript(jsonRequest('/x', 'GET'), ctx(id));
const claim = (code: string, token: string) => postClaim(jsonRequest('/x', 'POST', {}, cookieOf(token)), linkCtx(code));
const confirm = (id: string, consent: 'agree' | 'decline') => postConfirm(jsonRequest('/x', 'POST', { consent }), ctx(id));
const rowOf = async (id: string) => (await pk.registry<Record<string, any>>('SELECT * FROM registry.mandate_requests WHERE id = $1', [id]))[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
const requestFiles = () => pk.storeFiles().filter((f) => f.includes('registry-requests'));
const auditActionsOf = async (orgId: string) =>
  (await withTx({ kind: 'org', orgId }, (tx) => tx.query<{ action: string }>('SELECT action FROM audit.events ORDER BY seq'))).rows.map((r) => r.action);

describe('業者代傳謄本', () => {
  it('代傳成功：檔案放在業者組織名下的申請目錄，業者看得到檔名，屋主確認前原檔只有業者能讀', async () => {
    const data = await createOk();
    const res = await upload(data.id);
    expect(res.status).toBe(201);
    expect((await json(res)).data).toEqual({ id: data.id, file_name: '謄本.pdf' });
    const files = requestFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(`org/${practice.orgId}/registry-requests/${data.id}/transcript-`);
    expect(files[0]).not.toContain(owner.orgId);
    const row = await rowOf(data.id);
    expect(row.draft_transcript.object_key).toContain(`org/${practice.orgId}/registry-requests/${data.id}/`);
    expect((await json(await getOne(jsonRequest('/x', 'GET'), ctx(data.id)))).data.transcript_file_name).toBe('謄本.pdf');
    const opened = await read(data.id);
    expect(opened.status).toBe(200);
    expect(new Uint8Array(await opened.arrayBuffer())).toEqual(PDF);
    expect(opened.headers.get('cache-control')).toBe('no-store');
  });

  it('每次讀原檔都寫稽核事件（業者的鏈）', async () => {
    const data = await createOk();
    await upload(data.id);
    await read(data.id);
    await read(data.id);
    const actions = await auditActionsOf(practice.orgId);
    expect(actions.filter((a) => a === 'request.file_read')).toHaveLength(2);
    expect(actions).toContain('request.attach_file');
  });

  it('再傳一次取代上一份，舊檔刪除', async () => {
    const data = await createOk();
    await upload(data.id);
    const first = requestFiles();
    expect((await upload(data.id, { file: { bytes: new TextEncoder().encode('%PDF-1.7\n第二份'), name: '第二份.pdf', type: 'application/pdf' } })).status).toBe(201);
    const second = requestFiles();
    expect(second).toHaveLength(1);
    expect(second).not.toEqual(first);
    expect((await json(await getOne(jsonRequest('/x', 'GET'), ctx(data.id)))).data.transcript_file_name).toBe('第二份.pdf');
  });

  it('格式不合：沒有檔案、不是 PDF 或圖片、少了主張的所有權人，都回 400，沒有留下任何檔案', async () => {
    const data = await createOk();
    expect((await upload(data.id, { file: null })).status).toBe(400);
    expect((await upload(data.id, { file: { bytes: new TextEncoder().encode('純文字'), name: 'a.txt', type: 'text/plain' } })).status).toBe(400);
    expect((await upload(data.id, { claimedOwner: null })).status).toBe(400);
    expect((await upload(data.id, { acquiredAt: '2999-01-01' })).status).toBe(400);
    expect(requestFiles()).toEqual([]);
    expect((await rowOf(data.id)).draft_transcript).toBeNull();
  });

  it('別的業者、屋主組織、唯讀成員不能代傳也不能讀：別人的申請與不存在的申請回應逐位元相同，檔案不留', async () => {
    const data = await createOk();
    await upload(data.id);
    const other = await verifiedPractice(pk, 'practice-b@example.com');
    asPractice(other);
    const foreignRead = await snapshot(await read(data.id));
    expect(foreignRead.status).toBe(404);
    expectSameResponse(await snapshot(await read(NO_UNIT)), foreignRead);
    const foreignUpload = await snapshot(await upload(data.id));
    expect(foreignUpload.status).toBe(404);
    expectSameResponse(await snapshot(await upload(NO_UNIT)), foreignUpload);
    expect(requestFiles()).toHaveLength(1);
    asOwner();
    expect((await read(data.id)).status).toBe(403);
    expect((await upload(data.id)).status).toBe(403);
    actAsAccount(practice, 'practice', 'viewer');
    expect((await read(data.id)).status).toBe(403);
    expect((await upload(data.id)).status).toBe(403);
  });

  it('資料庫函式擋下指向別人檔案的路徑：業者不能把申請指到別的組織的檔案', async () => {
    const data = await createOk();
    const meta = (key: string) =>
      JSON.stringify({ object_key: key, sha256: 'a'.repeat(64), byte_size: 1, content_type: 'application/pdf', file_name: 'x.pdf', form: {} });
    const attempt = (key: string) =>
      withTx({ kind: 'org', orgId: practice.orgId, partyId: practice.partyId }, (tx) =>
        tx.query('SELECT * FROM registry.attach_mandate_request_transcript($1, $2::jsonb, now())', [data.id, meta(key)]),
      );
    await expect(attempt(`org/${owner.orgId}/transcripts/steal.pdf`)).rejects.toMatchObject({ code: '22023' });
    await expect(attempt(`org/${practice.orgId}/registry-requests/${NO_UNIT}/x.pdf`)).rejects.toMatchObject({ code: '22023' });
    await expect(attempt(`org/${practice.orgId}/transcripts/other.pdf`)).rejects.toMatchObject({ code: '22023' });
    expect((await rowOf(data.id)).draft_transcript).toBeNull();
  });

  it('已送出或已失效的申請不能再代傳', async () => {
    const data = await createOk();
    await pk.kit.asOwner((db) => db.query(`UPDATE registry.mandate_requests SET created_at = created_at - interval '8 days', link_expires_at = link_expires_at - interval '8 days' WHERE id = $1`, [data.id]));
    const res = await upload(data.id);
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('expired');
    expect(requestFiles()).toEqual([]);
  });
});

describe('屋主同意個資告知才轉謄本', () => {
  async function claimed() {
    const data = await createOk();
    expect((await upload(data.id)).status).toBe(201);
    expect((await claim(data.code, owner.token)).status).toBe(200);
    return data;
  }

  it('屋主看得到有謄本與檔名，看不到檔案 key 與業者組織的路徑', async () => {
    const data = await claimed();
    asOwner();
    const text = JSON.stringify((await json(await getOne(jsonRequest('/x', 'GET'), ctx(data.id)))).data);
    expect(JSON.parse(text)).toMatchObject({ has_transcript: true });
    expect(text).not.toContain('registry-requests');
    expect(text).not.toContain('object_key');
  });

  it('同意：謄本轉成屋主組織的謄本，送平台核對（待核對）；業者的原檔留到屋主送出', async () => {
    const data = await claimed();
    asOwner();
    const res = await confirm(data.id, 'agree');
    expect(res.status).toBe(201);
    const body = (await json(res)).data;
    expect(body.transcript).toBe('forwarded');
    const ownership = (await json(await getOwnership(jsonRequest('/x', 'GET') as never, ctx(body.id)))).data;
    expect(ownership).toMatchObject({ verification_status: 'pending_verification', node_status: 'pending_verification', submission_count: 1 });
    expect(ownership.submission.claimed_owner_name).toBe('王大明');
    expect(ownership.consent.agreed).toBe(true);
    // 屋主組織名下有自己的一份，業者名下的原檔還在
    const files = pk.storeFiles();
    expect(files.filter((f) => f.includes(`org/${owner.orgId}/transcripts/`))).toHaveLength(1);
    expect(files.filter((f) => f.includes(`org/${practice.orgId}/registry-requests/`))).toHaveLength(1);
    // 業者讀到的申請沒有任何改變
    asPractice();
    expect((await read(data.id)).status).toBe(200);
  });

  it('不同意：謄本不轉，申請仍能送出，物件沒有謄本', async () => {
    const data = await claimed();
    asOwner();
    const res = await confirm(data.id, 'decline');
    expect(res.status).toBe(201);
    const body = (await json(res)).data;
    expect(body.transcript).toBe('declined');
    const ownership = (await json(await getOwnership(jsonRequest('/x', 'GET') as never, ctx(body.id)))).data;
    expect(ownership).toMatchObject({ node_status: null, submission_count: 0 });
    expect(ownership.consent.agreed).toBe(false);
    expect(pk.storeFiles().filter((f) => f.includes(`org/${owner.orgId}/transcripts/`))).toEqual([]);
    const submitted = await postSubmit(jsonRequest('/x', 'POST', { unit_ids: [body.rental_unit_id] }), ctx(data.id));
    expect(submitted.status).toBe(200);
  });

  it('屋主送出後，業者代傳的原檔與代填資料刪除，業者讀原檔回 404', async () => {
    const data = await claimed();
    asOwner();
    const body = (await json(await confirm(data.id, 'agree'))).data;
    expect((await postSubmit(jsonRequest('/x', 'POST', { unit_ids: [body.rental_unit_id] }), ctx(data.id))).status).toBe(200);
    expect(pk.storeFiles().filter((f) => f.includes(`org/${practice.orgId}/registry-requests/`))).toEqual([]);
    const row = await rowOf(data.id);
    expect([row.draft, row.draft_transcript]).toEqual([null, null]);
    asPractice();
    expect((await read(data.id)).status).toBe(404);
    // 屋主組織自己的謄本還在
    expect(pk.storeFiles().filter((f) => f.includes(`org/${owner.orgId}/transcripts/`))).toHaveLength(1);
  });

  it('屋主沒確認就直接送出租賃單位：原檔與代填資料同樣刪除，不轉', async () => {
    const data = await claimed();
    asOwner();
    const unit = (await json(await postConfirmlessUnit())).unit;
    expect((await postSubmit(jsonRequest('/x', 'POST', { unit_ids: [unit] }), ctx(data.id))).status).toBe(200);
    expect(requestFiles()).toEqual([]);
    expect(pk.storeFiles().filter((f) => f.includes(`org/${owner.orgId}/transcripts/`))).toEqual([]);
  });

  it('連結失效後，業者讀列表時順手清掉資料與檔案；屋主端也讀不到', async () => {
    const data = await claimed();
    await pk.kit.asOwner((db) => db.query(`UPDATE registry.mandate_requests SET created_at = created_at - interval '8 days', link_expires_at = link_expires_at - interval '8 days' WHERE id = $1`, [data.id]));
    expect(requestFiles()).toHaveLength(1);
    asPractice();
    await getList();
    expect(requestFiles()).toEqual([]);
    const row = await rowOf(data.id);
    expect([row.draft, row.draft_transcript]).toEqual([null, null]);
    asOwner();
    expect((await confirm(data.id, 'agree')).status).toBe(409);
  });

  it('屋主端的物件列表只有屋主自己的物件', async () => {
    const data = await claimed();
    asOwner();
    await confirm(data.id, 'agree');
    expect(((await json(await getProperties())).data as unknown[]).length).toBe(1);
    asPractice();
    expect(((await json(await getProperties())).data as unknown[]).length).toBe(0);
  });
});

/** 屋主自己登錄一個物件（不經確認），回傳租賃單位 ID。 */
async function postConfirmlessUnit(): Promise<Response> {
  const { POST } = await import('../properties/route');
  const created = await POST(jsonRequest('/api/properties', 'POST', sampleDraft({ name: '自己登錄的物件' })));
  const id = (await json(created)).data.id as string;
  const list = (await json(await getProperties())).data as Array<{ id: string; rental_unit_id: string }>;
  return Response.json({ unit: list.find((p) => p.id === id)!.rental_unit_id });
}
