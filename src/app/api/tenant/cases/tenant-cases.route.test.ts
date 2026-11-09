import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findOrCreateParty } from '@/lib/case-store';
import { buildObjectKey, sha256Hex, type FileStore } from '@/lib/file-store';
import { createLocalFileStore } from '@/lib/file-store/local-file-store';
import { withTx } from '@/lib/pg/database';
import { actAs, actAsContext, actAsError, setupRouteDb, TEST_USER_ID, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import { Unauthenticated } from '@/lib/request-context';
import { GET as getList } from './route';
import { GET as getOne } from './[id]/route';
import { GET as getPdf } from './[id]/signed-pdf/route';

// 承租人端的 route（MIL-121）。連線是 PGlite 的 app_rw，RLS 生效。

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));
const store = vi.hoisted(() => ({ current: null as unknown as FileStore }));
vi.mock('@/lib/file-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/file-store')>()),
  getFileStore: () => store.current,
}));

let kit: RouteDb;
let dataDir: string;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-route-'));
  store.current = createLocalFileStore(dataDir);
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const PDF = new TextEncoder().encode('%PDF-已簽合約');
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new NextRequest('http://localhost/api/tenant/cases');
const snap = async (res: Response) => ({ status: res.status, body: await res.text() });
const NOT_FOUND = { status: 404, body: JSON.stringify({ error: '案件不存在' }) };
const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function seedCase(orgId: string, title: string, members: Array<{ email: string; relation: 'lessor' | 'lessee' }>, state = 'active') {
  const caseId = newUlid();
  const contractId = newUlid();
  const taskId = newUlid();
  const key = buildObjectKey(orgId, 'sign-tasks', taskId, 'signed.pdf');
  await store.current.write(key, PDF, { contentType: 'application/pdf' });
  await withTx({ kind: 'org', orgId }, async (tx) => {
    await tx.query(`INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', $3, 'self_managed', $4)`, [caseId, orgId, state, title]);
    await tx.query(`INSERT INTO org.contracts (id, org_id, case_id, status) VALUES ($1, $2, $3, 'completed')`, [contractId, orgId, caseId]);
    await tx.query(`UPDATE org.cases SET current_contract_id = $2 WHERE id = $1`, [caseId, contractId]);
    for (const m of members) {
      const partyId = await findOrCreateParty(tx, m.email, m.email.split('@')[0]);
      await tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation, valid_period) VALUES ($1, $2, $3, $4, $5, '[2026-01-01,)')`, [newUlid(), orgId, caseId, partyId, m.relation]);
    }
    await tx.query(`INSERT INTO org.sign_tasks (id, org_id, provider, provider_task_ref, subject_type, subject_id) VALUES ($1, $2, 'mock', $3, 'contract', $4)`, [taskId, orgId, `ref-${taskId}`, contractId]);
    await tx.query(
      `INSERT INTO org.sign_task_files (id, org_id, sign_task_id, kind, status, file_name, object_key, sha256, byte_size, content_type)
       VALUES ($1, $2, $3, 'signed_pdf', 'saved', '租賃契約書.pdf', $4, $5, $6, 'application/pdf')`,
      [newUlid(), orgId, taskId, key, sha256Hex(PDF), PDF.byteLength],
    );
  });
  return caseId;
}

async function actAsTenant(email: string) {
  const partyId = await withTx({ kind: 'control' }, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM control.parties WHERE email = $1', [email])).rows[0].id);
  actAsContext({ kind: 'party', userId: TEST_USER_ID, partyId, requestId: 't' });
  return partyId;
}

describe('身分：只接受 party 脈絡', () => {
  it('沒登入回 401', async () => {
    actAsError(new Unauthenticated());
    for (const res of [await getList(), await getOne(req(), ctx(newUlid())), await getPdf(req(), ctx(newUlid()))]) expect(res.status).toBe(401);
  });

  it('組織脈絡的請求回 403，即使同一個人也是案件成員', async () => {
    await seedCase(kit.orgA, '案件', [{ email: 'lessor@example.com', relation: 'lessor' }, { email: 'tenant@example.com', relation: 'lessee' }]);
    actAs(kit.orgA);
    for (const res of [await getList(), await getOne(req(), ctx(newUlid())), await getPdf(req(), ctx(newUlid()))]) expect(res.status).toBe(403);
  });

  it('operator 脈絡的請求回 403', async () => {
    actAsContext({ kind: 'operator', userId: TEST_USER_ID, partyId: newUlid(), requestId: 't' });
    expect((await getList()).status).toBe(403);
  });
});

describe('GET /api/tenant/cases：我的案件', () => {
  it('兩個組織的案件都列出（P0-21 AC1）', async () => {
    const a = await seedCase(kit.orgA, 'A 物件', [{ email: 'la@example.com', relation: 'lessor' }, { email: 'tenant@example.com', relation: 'lessee' }]);
    const b = await seedCase(kit.orgB, 'B 物件', [{ email: 'lb@example.com', relation: 'lessor' }, { email: 'tenant@example.com', relation: 'lessee' }], 'closed');
    await actAsTenant('tenant@example.com');
    const res = await getList();
    expect(res.status).toBe(200);
    const rows = (await json(res)).data;
    expect(rows.map((r: { id: string }) => r.id)).toEqual([b, a]);
    expect(rows.map((r: { orgName: string }) => r.orgName)).toEqual(['B 組織', 'A 組織']);
  });

  it('不屬於任何案件的 party：200 與空陣列，形狀與有案件時相同（P0-21 AC6）', async () => {
    await seedCase(kit.orgA, '案件', [{ email: 'lessor@example.com', relation: 'lessor' }, { email: 'tenant@example.com', relation: 'lessee' }]);
    const strangerId = newUlid();
    await withTx({ kind: 'control' }, (tx) => tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'nobody@example.com', 'n')`, [strangerId]));
    actAsContext({ kind: 'party', userId: TEST_USER_ID, partyId: strangerId, requestId: 't' });
    const res = await getList();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: [] });
    await actAsTenant('tenant@example.com');
    const withCases = await getList();
    expect(Object.keys(await json(withCases))).toEqual(['data']);
  });
});

describe('GET /api/tenant/cases/[id]', () => {
  it('成員讀到詳情，含合約狀態與已簽 PDF 是否可下載', async () => {
    const id = await seedCase(kit.orgA, 'A 物件', [{ email: 'lessor@example.com', relation: 'lessor' }, { email: 'tenant@example.com', relation: 'lessee' }]);
    await actAsTenant('tenant@example.com');
    const res = await getOne(req(), ctx(id));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ id, contract: { status: 'completed', hasSignedPdf: true }, relation: 'lessee' });
  });

  it('別人的案件、不存在的案件、格式錯誤的編號：回應逐位元相同（P0-09 AC1）', async () => {
    const others = await seedCase(kit.orgB, '別人的', [{ email: 'lb@example.com', relation: 'lessor' }, { email: 'other@example.com', relation: 'lessee' }]);
    await seedCase(kit.orgA, '我的', [{ email: 'lessor@example.com', relation: 'lessor' }, { email: 'tenant@example.com', relation: 'lessee' }]);
    await actAsTenant('tenant@example.com');
    const results = [await getOne(req(), ctx(others)), await getOne(req(), ctx(newUlid())), await getOne(req(), ctx('not-a-ulid'))];
    for (const r of results) expect(await snap(r)).toEqual(NOT_FOUND);
    for (const r of [await getPdf(req(), ctx(others)), await getPdf(req(), ctx(newUlid())), await getPdf(req(), ctx('x'))]) expect(await snap(r)).toEqual(NOT_FOUND);
  });

  it('不屬於任何案件的 party 開別人的案件，回應與不存在相同', async () => {
    const others = await seedCase(kit.orgB, '別人的', [{ email: 'lb@example.com', relation: 'lessor' }, { email: 'other@example.com', relation: 'lessee' }]);
    const strangerId = newUlid();
    await withTx({ kind: 'control' }, (tx) => tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'nobody@example.com', 'n')`, [strangerId]));
    actAsContext({ kind: 'party', userId: TEST_USER_ID, partyId: strangerId, requestId: 't' });
    expect(await snap(await getOne(req(), ctx(others)))).toEqual(NOT_FOUND);
    expect(await snap(await getOne(req(), ctx(newUlid())))).toEqual(NOT_FOUND);
  });
});

describe('GET /api/tenant/cases/[id]/signed-pdf', () => {
  it('成員下載已簽 PDF', async () => {
    const id = await seedCase(kit.orgA, 'A 物件', [{ email: 'lessor@example.com', relation: 'lessor' }, { email: 'tenant@example.com', relation: 'lessee' }]);
    await actAsTenant('tenant@example.com');
    const res = await getPdf(req(), ctx(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toContain(`filename*=UTF-8''${encodeURIComponent('租賃契約書.pdf')}`);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()))).toBe('%PDF-已簽合約');
  });

  it('結案後仍能下載（P0-09 AC6）', async () => {
    const id = await seedCase(kit.orgA, 'A 物件', [{ email: 'lessor@example.com', relation: 'lessor' }, { email: 'tenant@example.com', relation: 'lessee' }], 'closed');
    await actAsTenant('tenant@example.com');
    expect((await getPdf(req(), ctx(id))).status).toBe(200);
  });

  it('檔案不見了：404 並說明，不洩漏別的資訊', async () => {
    const id = await seedCase(kit.orgA, 'A 物件', [{ email: 'lessor@example.com', relation: 'lessor' }, { email: 'tenant@example.com', relation: 'lessee' }]);
    await store.current.delete(buildObjectKey(kit.orgA, 'sign-tasks', 'x', 'y')); // 只為了確認 delete 不丟錯
    for (const f of fs.readdirSync(dataDir, { recursive: true, withFileTypes: true })) if (f.isFile()) fs.rmSync(path.join(f.parentPath, f.name));
    await actAsTenant('tenant@example.com');
    const res = await getPdf(req(), ctx(id));
    expect(res.status).toBe(404);
    expect((await json(res)).error).toContain('暫時無法下載');
  });
});
