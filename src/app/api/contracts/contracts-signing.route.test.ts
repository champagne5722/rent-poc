import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { DATA_DIR } from '@/lib/db';
import { withTx } from '@/lib/pg/database';
import { actAs, actAsError, setupRouteDb, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import { Unauthenticated } from '@/lib/request-context';
import { POST as advance } from '../mock/advance/route';
import { POST as createProperty } from '../properties/route';
import { GET as getOne } from './[id]/route';
import { GET as getAuditTrail } from './[id]/audit-trail/route';
import { GET as getEvents } from './[id]/events/route';
import { GET as getFiles } from './[id]/files/route';
import { GET as getPdf } from './[id]/pdf/route';
import { POST as resend } from './[id]/resend/route';
import { POST as send } from './[id]/send/route';
import { GET as getSignLink } from './[id]/sign-link/route';
import { GET as getSignedPdf } from './[id]/signed-pdf/route';
import { PUT } from './[id]/route';
import { POST as voidContract } from './[id]/void/route';
import { POST as webhook } from '../webhooks/dottedsign/route';
import { GET as health } from '../health/route';
import { POST as create } from './route';

// 簽署模組把文件寫在 DATA_DIR。換成暫存目錄，測試不碰 repo 的 data/
vi.mock('@/lib/db', async (importOriginal) => {
  const os = await import('node:os');
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  return {
    ...(await importOriginal<typeof import('@/lib/db')>()),
    DATA_DIR: fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'contracts-signing-')),
  };
});

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-83：送簽、撤回、簽署連結與下載的 route 都改走 ULID。簽署模組用 mock 模式（沒有點點簽金鑰），
// 合約與簽署任務都在 PostgreSQL（PGlite，MIL-85）。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(async () => {
  await kit.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
});

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, payload?: unknown) =>
  new NextRequest('http://localhost/api/contracts/x', { method, body: payload === undefined ? undefined : JSON.stringify(payload) });
const snap = async (res: Response) => ({ status: res.status, body: await res.text() });
const NOT_FOUND = { status: 404, body: JSON.stringify({ error: '合約不存在' }) };

const SIGNATURE_FIELDS = [
  { id: 'f1', signer: 'party_a', page: 0, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
  { id: 'f2', signer: 'party_b', page: 0, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
];
const READY_FIELDS = {
  landlordName: '林房東',
  landlordEmail: 'landlord@example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
  startDate: '2026-09-01',
  endDate: '2027-08-31',
};

/** 建一份欄位齊全、簽名框設好的草稿。 */
async function readyDraft(): Promise<string> {
  const propertyRes = await createProperty(
    new NextRequest('http://localhost/api/properties', {
      method: 'POST',
      body: JSON.stringify({ name: '大安區溫馨兩房', address: '台北市大安區某路 1 號', default_rent: 20000, equipment: [] }),
    }),
  );
  const propertyId = (await json(propertyRes)).data.id;
  const res = await create(new NextRequest('http://localhost/api/contracts', { method: 'POST', body: JSON.stringify({ property_id: propertyId }) }));
  const id = (await json(res)).data.id;
  await PUT(req('PUT', { fields: READY_FIELDS, signature_fields: SIGNATURE_FIELDS }), ctx(id));
  return id;
}

const statusOf = async (id: string) => (await json(await getOne(req('GET'), ctx(id)))).data.status;
const eventTypes = async (id: string) => (await json(await getEvents(req('GET'), ctx(id)))).data.map((e: { type: string }) => e.type);
const mockAdvance = (contractId: unknown, event: string, reason?: string) =>
  advance(new NextRequest('http://localhost/api/mock/advance', { method: 'POST', body: JSON.stringify({ contract_id: contractId, event, reason }) }));

describe('POST /api/contracts/[id]/send', () => {
  it('送簽：回 { data: { id, mock: true } }，合約進入待乙方簽，記送簽歷程，簽署進度有兩位簽署人', async () => {
    const id = await readyDraft();
    const res = await send(req('POST'), ctx(id));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: { id, mock: true, notices: [] } });

    const one = await json(await getOne(req('GET'), ctx(id)));
    expect(one.data.status).toBe('awaiting_tenant');
    expect(one.signing_progress).toMatchObject({
      status: 'in_progress',
      currentSigner: { role: 'party_b', name: '王租客', email: 'tenant@example.com' },
    });
    expect(one.signing_progress.signers.map((s: { role: string }) => s.role)).toEqual(['party_b', 'party_a']);
    expect(await eventTypes(id)).toEqual(['created', 'sent']);
  });

  it('欄位沒填齊回 400 與缺的欄位；非草稿回 409；重送回 409', async () => {
    const propertyRes = await createProperty(
      new NextRequest('http://localhost/api/properties', { method: 'POST', body: JSON.stringify({ name: 'x', address: 'y', equipment: [] }) }),
    );
    const created = await create(
      new NextRequest('http://localhost/api/contracts', { method: 'POST', body: JSON.stringify({ property_id: (await json(propertyRes)).data.id }) }),
    );
    const empty = (await json(created)).data.id;
    const missing = await send(req('POST'), ctx(empty));
    expect(missing.status).toBe(400);
    expect((await json(missing)).error).toContain('甲方姓名');

    const id = await readyDraft();
    await send(req('POST'), ctx(id));
    expect(await snap(await send(req('POST'), ctx(id)))).toEqual({ status: 409, body: JSON.stringify({ error: '僅草稿可送簽' }) });
  });

  it('別的組織、不存在、格式錯誤的 ID 回同一個 404', async () => {
    const id = await readyDraft();
    actAs(kit.orgB);
    for (const bad of [id, newUlid(), 'abc']) expect(await snap(await send(req('POST'), ctx(bad)))).toEqual(NOT_FOUND);
    actAs(kit.orgA);
    expect(await statusOf(id)).toBe('draft');
  });

  it('沒登入回 401', async () => {
    const id = await readyDraft();
    actAsError(new Unauthenticated());
    expect((await send(req('POST'), ctx(id))).status).toBe(401);
  });
});

describe('簽署流程：mock advance 推進、撤回、下載', () => {
  async function sentContract(): Promise<string> {
    const id = await readyDraft();
    await send(req('POST'), ctx(id));
    return id;
  }

  it('乙方簽、甲方簽到完成：每一步回 { data: { id, status } }，歷程與已簽 PDF 都在', async () => {
    const id = await sentContract();

    const tenant = await mockAdvance(id, 'signed');
    expect(await json(tenant)).toEqual({ data: { id, status: 'awaiting_landlord' } });
    const done = await mockAdvance(id, 'completed');
    expect(await json(done)).toEqual({ data: { id, status: 'completed' } });

    expect(await eventTypes(id)).toEqual(['created', 'sent', 'signer_signed', 'completed']);
    const files = await json(await getFiles(req('GET'), ctx(id)));
    expect(files.data).toEqual([
      expect.objectContaining({ kind: 'signed_pdf', status: 'saved', contract_id: id, file_name: `contract-${id}-signed.pdf` }),
    ]);
    const pdf = await getSignedPdf(req('GET'), ctx(id));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-disposition')).toBe(`attachment; filename="contract-${id}-signed.pdf"`);
    expect((await pdf.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });

  it('乙方拒簽：合約已拒簽，原因寫進合約與歷程附註', async () => {
    const id = await sentContract();
    const res = await mockAdvance(id, 'declined', '租金認知有落差');
    expect(await json(res)).toEqual({ data: { id, status: 'declined' } });

    const one = (await json(await getOne(req('GET'), ctx(id)))).data;
    expect(one).toMatchObject({ status: 'declined', declined_reason: '租金認知有落差' });
    const events = (await json(await getEvents(req('GET'), ctx(id)))).data;
    expect(events.at(-1)).toMatchObject({ type: 'declined', actor: 'party_b', note: '租金認知有落差' });
  });

  it('撤回：回 { data: { id } }，狀態已撤回；之後複製會記衍生關聯', async () => {
    const id = await sentContract();
    const res = await voidContract(req('POST'), ctx(id));
    expect(await json(res)).toEqual({ data: { id } });
    expect(await statusOf(id)).toBe('voided');
    expect(await eventTypes(id)).toEqual(['created', 'sent', 'voided']);
  });

  it('草稿不能撤回：409 與訊息；別的組織與格式錯誤的 ID 回 404', async () => {
    const id = await readyDraft();
    expect(await snap(await voidContract(req('POST'), ctx(id)))).toEqual({
      status: 409,
      body: JSON.stringify({ error: '僅簽署中的合約可撤回' }),
    });
    actAs(kit.orgB);
    expect(await snap(await voidContract(req('POST'), ctx(id)))).toEqual(NOT_FOUND);
    expect(await snap(await voidContract(req('POST'), ctx('abc')))).toEqual(NOT_FOUND);
  });

  it('mock advance 的 contract_id 不是 ULID 或不存在時回同一個 404', async () => {
    for (const bad of [3, '3', null, undefined, newUlid()]) expect(await snap(await mockAdvance(bad, 'signed'))).toEqual(NOT_FOUND);
  });

  it('簽署連結與重寄：mock 模式回 409 與訊息；ID 不合回 404', async () => {
    const id = await sentContract();
    const link = await getSignLink(req('GET'), ctx(id));
    expect(link.status).toBe(409);
    expect((await json(link)).error).toEqual(expect.any(String));
    expect((await resend(req('POST'), ctx(id))).status).toBe(409);
    expect(await snap(await getSignLink(req('GET'), ctx('abc')))).toEqual(NOT_FOUND);
    actAs(kit.orgB);
    expect(await snap(await resend(req('POST'), ctx(id)))).toEqual(NOT_FOUND);
  });

  it('audit trail 下載：mock 模式沒有這份文件，回 409；尚未完成也回 409', async () => {
    const id = await sentContract();
    expect((await getAuditTrail(req('GET'), ctx(id))).status).toBe(409);
    expect(await snap(await getAuditTrail(req('GET'), ctx('abc')))).toEqual(NOT_FOUND);
    expect(await snap(await getSignedPdf(req('GET'), ctx(newUlid())))).toEqual(NOT_FOUND);
  });

  it('同時兩個送簽請求：只有一個成功，另一個 409，合約只送簽一次', async () => {
    const id = await readyDraft();
    const [a, b] = await Promise.all([send(req('POST'), ctx(id)), send(req('POST'), ctx(id))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await eventTypes(id)).toEqual(['created', 'sent']);
  });
});

describe('GET /api/contracts/[id]/pdf', () => {
  it('回 PDF；別的組織與格式錯誤的 ID 回 404', async () => {
    const id = await readyDraft();
    const res = await getPdf(req('GET'), ctx(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(`inline; filename="contract-${id}.pdf"`);
    expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5))).toBe('%PDF-');

    actAs(kit.orgB);
    expect(await snap(await getPdf(req('GET'), ctx(id)))).toEqual(NOT_FOUND);
    expect(await snap(await getPdf(req('GET'), ctx('abc')))).toEqual(NOT_FOUND);
  });
});

describe('送簽失敗與 webhook（MIL-85）', () => {
  const failEventWrites = () =>
    kit.asOwner((pg) =>
      pg.exec(`CREATE FUNCTION org.fail_contract_events() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '歷程寫入失敗'; END $$;
               CREATE TRIGGER fail_contract_events BEFORE INSERT ON org.contract_events FOR EACH ROW EXECUTE FUNCTION org.fail_contract_events();`),
    );
  const taskRows = () =>
    kit.asOwner(async (pg) => (await pg.query<{ provider_task_ref: string; org_id: string }>('SELECT provider_task_ref, org_id FROM control.sign_task_routes')).rows);
  const webhookReq = (body: string) => new NextRequest('http://localhost/api/webhooks/dottedsign', { method: 'POST', body });

  it('送簽寫入失敗：回 502 與原因，合約留在草稿，沒有簽署任務與路由列，送簽的 outbox 列轉失敗', async () => {
    const id = await readyDraft();
    await failEventWrites();

    const res = await send(req('POST'), ctx(id));

    expect(res.status).toBe(502);
    expect(await json(res)).toEqual({ error: '歷程寫入失敗' });
    expect(await statusOf(id)).toBe('draft');
    expect(await taskRows()).toEqual([]);
    const outbox = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => (await tx.query('SELECT action, status, last_error FROM org.outbox')).rows);
    expect(outbox).toEqual([{ action: 'create_sign_task', status: 'failed', last_error: '歷程寫入失敗' }]);
    // 使用者能重新送簽
    await kit.asOwner((pg) => pg.exec('DROP TRIGGER fail_contract_events ON org.contract_events'));
    expect((await send(req('POST'), ctx(id))).status).toBe(200);
  });

  it('送簽成功：路由列指向送簽的組織，回應不帶服務商任務編號', async () => {
    const id = await readyDraft();
    const res = await send(req('POST'), ctx(id));
    expect(Object.keys((await json(res)).data).sort()).toEqual(['id', 'mock', 'notices']);
    const [route] = await taskRows();
    expect(route.org_id).toBe(kit.orgA);
    expect(route.provider_task_ref).toMatch(/^mock-/);
  });

  it('webhook：沒有請求身分也能由路由列處理，回 { ok: true }，合約往下一位前進', async () => {
    const id = await readyDraft();
    await send(req('POST'), ctx(id));
    const [{ provider_task_ref }] = await taskRows();
    // webhook 沒有登入，請求脈絡取不到
    actAsError(new Unauthenticated());

    const ack = await webhook(
      webhookReq(JSON.stringify({ resource_id: provider_task_ref, resource_type: 'task', action_name: 'signed', event_email: 'tenant@example.com' })),
    );

    expect(ack.status).toBe(200);
    expect(await json(ack)).toEqual({ ok: true });
    actAs(kit.orgA);
    expect(await statusOf(id)).toBe('awaiting_landlord');
  });

  it('webhook：空 body 是 ping，對不到的任務回 ignored，無效 JSON 回 400', async () => {
    expect(await json(await webhook(webhookReq('')))).toEqual({ ok: true, ping: true });
    const ignored = await webhook(webhookReq(JSON.stringify({ resource_id: 'no-such', resource_type: 'task', action_name: 'signed', event_email: 'x@example.com' })));
    expect(ignored.status).toBe(200);
    expect(await json(ignored)).toEqual({ ok: true, ignored: true });
    const bad = await webhook(webhookReq('not-json'));
    expect(bad.status).toBe(400);
    expect(await json(bad)).toEqual({ error: expect.any(String) });
  });

  it('GET /api/health：能連上 PostgreSQL 回 { ok: true }', async () => {
    const res = await health();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
  });
});
