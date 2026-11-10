import { NextRequest } from 'next/server';
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_DIR } from '@/lib/db';
import { advanceOwnership, createPropertyAt, createVerifiedProperty, lapseOwnership, type OwnershipStage } from '@/lib/ownership/test-kit';
import { PROPERTY_NOT_VERIFIED_MESSAGE } from '@/lib/ownership/gate';
import { withTx } from '@/lib/pg/database';
import { actAs, setupRouteDb, TEST_PARTY_ID, type RouteDb } from '@/lib/pg/route-test-kit';
import type { SignatureField } from '@/lib/types';
import { GET as getOne, PUT } from './[id]/route';
import { GET as getPractitioners } from './[id]/practitioners/route';
import { POST as send } from './[id]/send/route';
import { POST as createRoute } from './route';

// 簽署模組把文件寫在 DATA_DIR。換成暫存目錄，測試不碰 repo 的 data/
vi.mock('@/lib/db', async (importOriginal) => {
  const os = await import('node:os');
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  return {
    ...(await importOriginal<typeof import('@/lib/db')>()),
    DATA_DIR: fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'contracts-gate-send-')),
  };
});

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-205：送簽時，這個組織對合約的物件必須有已驗證的所有權節點（ADR-0028 決議 5）。
// 接縫是 POST /api/contracts/[id]/send 與 GET /api/contracts/[id]/practitioners（送簽預覽，原因必須一致）。
// 草稿在規則生效前已建立（或節點之後失效），所以用 repository 直接建，不經 POST /api/contracts。

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
const req = (method: string) => new NextRequest('http://localhost/api/contracts/x', { method });

const READY_FIELDS = {
  landlordName: '林房東',
  landlordEmail: 'landlord@example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
  startDate: '2026-09-01',
  endDate: '2027-08-31',
  rent: 21000,
};
const SIGNATURE_FIELDS: SignatureField[] = [
  { id: 'f1', signer: 'party_a', page: 0, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
  { id: 'f2', signer: 'party_b', page: 0, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
];

/**
 * 在指定物件上備一份欄位齊全的草稿，不檢查核對（模擬規則生效前建立的草稿，或節點之後才失效）。
 * 草稿先在已核對的物件上走正式的建立 route，再把 property_id 改到目標物件。目標是 null 時模擬沒有物件的資料。
 */
async function draftOn(propertyId: string | null): Promise<string> {
  const seedProperty = await createVerifiedProperty(kit);
  const created = await createRoute(new NextRequest('http://localhost/api/contracts', { method: 'POST', body: JSON.stringify({ property_id: seedProperty }) }));
  const id = (await json(created)).data.id as string;
  const saved = await PUT(new NextRequest('http://localhost/api/contracts/x', { method: 'PUT', body: JSON.stringify({ fields: READY_FIELDS, signature_fields: SIGNATURE_FIELDS }) }), ctx(id));
  expect(saved.status).toBe(200);
  await withTx({ kind: 'org', orgId: kit.orgA, partyId: TEST_PARTY_ID }, (tx) => tx.query('UPDATE org.contracts SET property_id = $2 WHERE id = $1', [id, propertyId]));
  return id;
}

const statusOf = async (id: string) => (await json(await getOne(req('GET'), ctx(id)))).data.status as string;
const reasonsOf = (body: Record<string, any>) => (body.reasons as Array<{ code: string; message: string }>).map((r) => r.code); // eslint-disable-line @typescript-eslint/no-explicit-any

// 節點的四種狀態加上沒有節點，對送簽的結果。原因碼來自 preconditions.ts，文字沿用既有的。
const TABLE: Array<{ name: string; stage: OwnershipStage | 'unsubmitted' | 'lapsed'; code: string }> = [
  { name: '沒有節點', stage: 'unsubmitted', code: 'property_not_verified' },
  { name: '待驗證', stage: 'pending_verification', code: 'primary_authority_pending' },
  { name: '驗證失敗', stage: 'failed', code: 'primary_authority_failed' },
  { name: '已失效', stage: 'lapsed', code: 'primary_authority_lapsed' },
];

async function propertyAt(stage: OwnershipStage | 'unsubmitted' | 'lapsed'): Promise<string> {
  if (stage !== 'lapsed') return createPropertyAt(kit, stage);
  const id = await createPropertyAt(kit, 'verified');
  await lapseOwnership(kit, id);
  return id;
}

describe('POST /api/contracts/[id]/send', () => {
  it.each(TABLE)('$name：送簽被拒，回 400 與原因，合約維持草稿', async ({ stage, code }) => {
    const id = await draftOn(await propertyAt(stage));
    const res = await send(req('POST'), ctx(id));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(reasonsOf(body)).toEqual([code]);
    expect(body.error).toContain('無法送簽');
    expect(await statusOf(id)).toBe('draft');
  });

  it('已驗證：送簽成功，合約進入待乙方簽', async () => {
    const id = await draftOn(await createPropertyAt(kit, 'verified'));
    const res = await send(req('POST'), ctx(id));
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('awaiting_tenant');
  });

  it('沒有物件的租賃合約（資料不完整）：不放行', async () => {
    const id = await draftOn(null);
    const res = await send(req('POST'), ctx(id));
    expect(res.status).toBe(400);
    expect(reasonsOf(await json(res))).toEqual(['property_not_verified']);
    expect(await statusOf(id)).toBe('draft');
  });

  it('沒有節點的原因文字是固定的「物件尚未通過平台的文件核對」，不提到別人', async () => {
    const id = await draftOn(await createPropertyAt(kit, 'unsubmitted'));
    const body = await json(await send(req('POST'), ctx(id)));
    expect(body.reasons[0].message).toContain(PROPERTY_NOT_VERIFIED_MESSAGE);
    expect(JSON.stringify(body)).not.toMatch(/審核單號|已在平台登錄|已送審核|撞號|重複|別的組織|其他組織/);
  });

  it('驗證失敗後補件通過：同一份草稿能送簽', async () => {
    const propertyId = await createPropertyAt(kit, 'failed');
    const id = await draftOn(propertyId);
    expect((await send(req('POST'), ctx(id))).status).toBe(400);
    await advanceOwnership(kit, propertyId, 'verified');
    expect((await send(req('POST'), ctx(id))).status).toBe(200);
  });

  it('別的組織核對通過，不代表這個組織通過', async () => {
    actAs(kit.orgB);
    await createPropertyAt(kit, 'verified');
    actAs(kit.orgA);
    const id = await draftOn(await createPropertyAt(kit, 'pending_verification'));
    expect(reasonsOf(await json(await send(req('POST'), ctx(id))))).toEqual(['primary_authority_pending']);
  });
});

describe('GET /api/contracts/[id]/practitioners（送簽預覽）', () => {
  it.each(TABLE)('$name：預覽列出的原因與送簽相同', async ({ stage, code }) => {
    const id = await draftOn(await propertyAt(stage));
    const preview = await json(await getPractitioners(req('GET'), ctx(id)));
    expect(preview.data.evaluation.ok).toBe(false);
    expect(reasonsOf({ reasons: preview.data.evaluation.reasons })).toEqual([code]);
    const sent = await json(await send(req('POST'), ctx(id)));
    expect(reasonsOf(sent)).toEqual(reasonsOf({ reasons: preview.data.evaluation.reasons }));
  });

  it('已驗證：預覽沒有核對的原因', async () => {
    const id = await draftOn(await createPropertyAt(kit, 'verified'));
    const preview = await json(await getPractitioners(req('GET'), ctx(id)));
    expect(preview.data.evaluation).toMatchObject({ ok: true, reasons: [] });
  });
});

describe('新規則生效前已送簽的合約不受影響', () => {
  it('送簽後節點才失效：合約維持簽署中，讀取照常', async () => {
    const propertyId = await createPropertyAt(kit, 'verified');
    const id = await draftOn(propertyId);
    expect((await send(req('POST'), ctx(id))).status).toBe(200);
    await lapseOwnership(kit, propertyId);
    const one = await getOne(req('GET'), ctx(id));
    expect(one.status).toBe(200);
    expect((await json(one)).data.status).toBe('awaiting_tenant');
  });
});
