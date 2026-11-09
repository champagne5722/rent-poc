import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTx } from '@/lib/pg/database';
import { actAs, actAsError, setupRouteDb, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import { Unauthenticated } from '@/lib/request-context';
import { DELETE as deleteProperty } from '../properties/[id]/route';
import { POST as createProperty } from '../properties/route';
import { DELETE, GET as getOne, PUT } from './[id]/route';
import { POST as copy } from './[id]/copy/route';
import { GET as getEvents } from './[id]/events/route';
import { GET as getFiles, POST as refetchFiles } from './[id]/files/route';
import { GET as getList, POST } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-83：合約 route 的 response body。合約在 PostgreSQL（PGlite，app_rw，RLS 生效）。
// 涵蓋 MIL-37 第 4.5 節丙類的合約位置：漏 await 時 Response.json 會把 Promise 變成 {}，
// 所以每個位置都驗本文，不只看狀態碼。簽署任務還在 SQLite（MIL-85 搬走），用 in-memory。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
});

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, payload?: unknown) =>
  new NextRequest('http://localhost/api/contracts/x', { method, body: payload === undefined ? undefined : JSON.stringify(payload) });

const createContract = (propertyId: unknown, extra: Record<string, unknown> = {}) =>
  POST(new NextRequest('http://localhost/api/contracts', { method: 'POST', body: JSON.stringify({ property_id: propertyId, ...extra }) }));

async function newProperty(over: Record<string, unknown> = {}): Promise<string> {
  const res = await createProperty(
    new NextRequest('http://localhost/api/properties', {
      method: 'POST',
      body: JSON.stringify({
        name: '大安區溫馨兩房',
        address: '台北市大安區某路 1 號',
        default_rent: 20000,
        equipment: [{ name: '冷氣', quantity: 1 }],
        ...over,
      }),
    }),
  );
  return (await json(res)).data.id;
}

async function newContract(extra: Record<string, unknown> = {}): Promise<{ id: string; propertyId: string }> {
  const propertyId = await newProperty();
  const res = await createContract(propertyId, extra);
  expect(res.status).toBe(201);
  return { id: (await json(res)).data.id, propertyId };
}

const setStatus = (id: string, status: string) =>
  withTx({ kind: 'org', orgId: kit.orgA }, (tx) => tx.query('UPDATE org.contracts SET status = $2 WHERE id = $1', [id, status]));

const NOT_FOUND = { status: 404, body: JSON.stringify({ error: '合約不存在' }) };
const snap = async (res: Response) => ({ status: res.status, body: await res.text() });

describe('POST /api/contracts', () => {
  it('從物件建草稿：回 201 與合約 ULID，物件資料帶入成快照，property_id 存物件的 ULID', async () => {
    const propertyId = await newProperty();
    const res = await createContract(propertyId);
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(Object.keys(body)).toEqual(['data']);
    expect(body.data.id).toMatch(ULID);

    const one = await json(await getOne(req('GET'), ctx(body.data.id)));
    expect(one.data).toMatchObject({
      id: body.data.id,
      property_id: propertyId,
      status: 'draft',
      contract_type: 'lease',
      derived_from: null,
      declined_reason: null,
      fields: {
        propertyName: '大安區溫馨兩房',
        propertyAddress: '台北市大安區某路 1 號',
        rent: 20000,
        deposit: 40000,
        equipmentAnnex: [{ name: '冷氣', quantity: 1, repair: 'landlord', note: '' }],
      },
      signature_fields: [],
    });
  });

  it('分流條件（MIL-67）存進 fields.routing，原樣讀回', async () => {
    const routing = { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: true };
    const { id } = await newContract({ routing });
    const one = await json(await getOne(req('GET'), ctx(id)));
    expect(one.data.fields.routing).toEqual(routing);
  });

  it('分流條件格式不對回 400，什麼都沒建', async () => {
    const propertyId = await newProperty();
    const res = await createContract(propertyId, { routing: { businessType: 'sublease' } });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toEqual(expect.any(String));
    expect((await json(await getList())).data).toEqual([]);
  });

  it('別的組織的物件、不存在的物件、格式錯誤的 ID，回應逐位元相同', async () => {
    actAs(kit.orgB);
    const bProperty = await newProperty();
    actAs(kit.orgA);
    const cross = await snap(await createContract(bProperty));
    expect(cross).toEqual({ status: 400, body: JSON.stringify({ error: '請指定有效的物件' }) });
    expect(await snap(await createContract(newUlid()))).toEqual(cross);
    for (const bad of [3, '3', 'abc', null, undefined]) expect(await snap(await createContract(bad))).toEqual(cross);
    expect((await json(await getList())).data).toEqual([]);
  });

  it('建立同時寫「建立」歷程與稽核事件', async () => {
    const { id } = await newContract();
    const events = await json(await getEvents(req('GET'), ctx(id)));
    expect(events.data).toEqual([
      { id: expect.stringMatching(ULID), contract_id: id, type: 'created', actor: 'landlord', note: null, created_at: expect.stringMatching(/^\d{4}-/) },
    ]);
    const audit = await withTx({ kind: 'org', orgId: kit.orgA }, (tx) =>
      tx.query<{ action: string; object_id: string }>(`SELECT action, object_id FROM audit.events WHERE action = 'contract.create'`),
    );
    expect(audit.rows).toEqual([{ action: 'contract.create', object_id: id }]);
  });

  it('沒登入回 401，不是組織身分回 403', async () => {
    const propertyId = await newProperty();
    actAsError(new Unauthenticated());
    expect((await createContract(propertyId)).status).toBe(401);
    expect((await getList()).status).toBe(401);
  });
});

describe('GET /api/contracts（清單）', () => {
  it('沒有合約時回空陣列', async () => {
    const res = await getList();
    expect(res.status).toBe(200);
    // 清單多回 signing_progress（MIL-72）。沒有簽署任務的合約不在裡面
    expect(await json(res)).toEqual({ data: [], signing_progress: {} });
  });

  it('草稿沒有簽署任務，signing_progress 不含它', async () => {
    await newContract();
    const body = await json(await getList());
    expect(body.data).toHaveLength(1);
    expect(body.signing_progress).toEqual({});
  });

  it('新的在前，每筆有完整欄位（不是 {}），fields 是物件', async () => {
    const first = await newContract();
    const second = await newContract();
    const { data } = await json(await getList());
    expect(data.map((c: { id: string }) => c.id)).toEqual([second.id, first.id]);
    expect(data[1]).toEqual({
      id: first.id,
      property_id: first.propertyId,
      contract_type: 'lease',
      status: 'draft',
      fields: expect.objectContaining({ propertyName: '大安區溫馨兩房', rent: 20000 }),
      signature_fields: [],
      declined_reason: null,
      derived_from: null,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      updated_at: null,
    });
  });

  it('只列自己組織的合約', async () => {
    actAs(kit.orgB);
    await newContract();
    actAs(kit.orgA);
    expect(await json(await getList())).toEqual({ data: [], signing_progress: {} });
  });
});

describe('GET /api/contracts/[id]', () => {
  it('回本體、衍生鏈鄰居與簽署進度（草稿沒有簽署任務是 null）', async () => {
    const { id } = await newContract();
    const res = await getOne(req('GET'), ctx(id));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      data: expect.objectContaining({ id, status: 'draft' }),
      relations: { derived_from: null, derived_contracts: [] },
      signing_progress: null,
    });
  });

  it('格式錯誤、別的組織、不存在的 ID，回應逐位元相同', async () => {
    actAs(kit.orgB);
    const { id: bId } = await newContract();
    actAs(kit.orgA);
    expect(await snap(await getOne(req('GET'), ctx(newUlid())))).toEqual(NOT_FOUND);
    expect(await snap(await getOne(req('GET'), ctx(bId)))).toEqual(NOT_FOUND);
    for (const bad of ['1', 'abc', '../x']) expect(await snap(await getOne(req('GET'), ctx(bad)))).toEqual(NOT_FOUND);
  });
});

describe('PUT /api/contracts/[id]', () => {
  it('草稿：欄位合併、簽署區域覆寫，回 { data: { id } }，updated_at 有值', async () => {
    const { id } = await newContract();
    const sig = [{ id: 'f1', signer: 'party_a', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.05 }];
    const res = await PUT(req('PUT', { fields: { landlordName: '林房東', rent: 30000 }, signature_fields: sig }), ctx(id));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: { id } });

    const one = (await json(await getOne(req('GET'), ctx(id)))).data;
    expect(one.fields).toMatchObject({ landlordName: '林房東', rent: 30000, propertyName: '大安區溫馨兩房' });
    expect(one.signature_fields).toEqual(sig);
    expect(one.updated_at).toMatch(/^\d{4}-/);
  });

  it('沒帶 signature_fields 時保留原值', async () => {
    const { id } = await newContract();
    const sig = [{ id: 'f1', signer: 'party_b', page: 0, x: 0, y: 0, w: 1, h: 1 }];
    await PUT(req('PUT', { signature_fields: sig }), ctx(id));
    await PUT(req('PUT', { fields: { extra: '備註' } }), ctx(id));
    const one = (await json(await getOne(req('GET'), ctx(id)))).data;
    expect(one.signature_fields).toEqual(sig);
    expect(one.fields.extra).toBe('備註');
  });

  it('非草稿回 409，內容不變', async () => {
    const { id } = await newContract();
    await setStatus(id, 'awaiting_tenant');
    const res = await PUT(req('PUT', { fields: { rent: 1 } }), ctx(id));
    expect(await snap(res)).toEqual({ status: 409, body: JSON.stringify({ error: '僅草稿可編輯；已送簽的合約請先撤回' }) });
    expect((await json(await getOne(req('GET'), ctx(id)))).data.fields.rent).toBe(20000);
  });

  it('分流條件格式不對回 400，內容不變', async () => {
    const { id } = await newContract();
    const res = await PUT(req('PUT', { fields: { routing: { businessType: 'sublease' } } }), ctx(id));
    expect(res.status).toBe(400);
    expect((await json(await getOne(req('GET'), ctx(id)))).data.fields.routing).toBeUndefined();
  });

  it.each([
    ['本文不是物件', 'oops'],
    ['fields 不是物件', { fields: [] }],
    ['signature_fields 不是陣列', { signature_fields: {} }],
  ])('%s：回 400', async (_label, payload) => {
    const { id } = await newContract();
    expect((await PUT(req('PUT', payload), ctx(id))).status).toBe(400);
  });

  it('別的組織、不存在、格式錯誤的 ID 回同一個 404', async () => {
    actAs(kit.orgB);
    const { id: bId } = await newContract();
    actAs(kit.orgA);
    for (const id of [bId, newUlid(), 'abc']) {
      expect(await snap(await PUT(req('PUT', { fields: {} }), ctx(id)))).toEqual(NOT_FOUND);
    }
    actAs(kit.orgB);
    expect((await json(await getOne(req('GET'), ctx(bId)))).data.fields.rent).toBe(20000);
  });
});

describe('DELETE /api/contracts/[id]', () => {
  it('草稿：回 { data: { id } }，合約與歷程都消失，並記稽核事件', async () => {
    const { id } = await newContract();
    const res = await DELETE(req('DELETE'), ctx(id));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: { id } });

    expect(await snap(await getOne(req('GET'), ctx(id)))).toEqual(NOT_FOUND);
    expect(await snap(await getEvents(req('GET'), ctx(id)))).toEqual(NOT_FOUND);
    expect(await kit.asOwner(async (db) => (await db.query('SELECT 1 FROM org.contract_events')).rows)).toEqual([]);
    const audit = await withTx({ kind: 'org', orgId: kit.orgA }, (tx) =>
      tx.query<{ action: string }>(`SELECT action FROM audit.events WHERE action = 'contract.delete'`),
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('非草稿回 409，合約還在', async () => {
    const { id } = await newContract();
    await setStatus(id, 'completed');
    expect(await snap(await DELETE(req('DELETE'), ctx(id)))).toEqual({ status: 409, body: JSON.stringify({ error: '僅草稿可刪除' }) });
    expect((await getOne(req('GET'), ctx(id))).status).toBe(200);
  });

  it('別的組織、不存在、格式錯誤的 ID 回同一個 404，B 的合約還在', async () => {
    actAs(kit.orgB);
    const { id: bId } = await newContract();
    actAs(kit.orgA);
    for (const id of [bId, newUlid(), 'abc']) expect(await snap(await DELETE(req('DELETE'), ctx(id)))).toEqual(NOT_FOUND);
    actAs(kit.orgB);
    expect((await getOne(req('GET'), ctx(bId))).status).toBe(200);
  });
});

describe('POST /api/contracts/[id]/copy', () => {
  it('撤回後複製：回 201 與新合約 ULID，新約記衍生關聯，詳情的 relations 兩邊都對得上', async () => {
    const { id } = await newContract();
    await setStatus(id, 'voided');
    const res = await copy(req('POST'), ctx(id));
    expect(res.status).toBe(201);
    const newId = (await json(res)).data.id;
    expect(newId).toMatch(ULID);
    expect(newId).not.toBe(id);

    const created = (await json(await getOne(req('GET'), ctx(newId)))).data;
    expect(created).toMatchObject({ derived_from: id, status: 'draft' });
    expect((await json(await getOne(req('GET'), ctx(newId)))).relations).toEqual({
      derived_from: { id, status: 'voided' },
      derived_contracts: [],
    });
    expect((await json(await getOne(req('GET'), ctx(id)))).relations).toEqual({
      derived_from: null,
      derived_contracts: [{ id: newId, status: 'draft' }],
    });
    const sourceEvents = (await json(await getEvents(req('GET'), ctx(id)))).data;
    expect(sourceEvents.at(-1)).toMatchObject({ type: 'copied', note: `複製為新草稿：合約 #${newId.slice(-6)}` });
  });

  it('拒簽後複製：不記衍生關聯', async () => {
    const { id } = await newContract();
    await setStatus(id, 'declined');
    const newId = (await json(await copy(req('POST'), ctx(id)))).data.id;
    const body = await json(await getOne(req('GET'), ctx(newId)));
    expect(body.data.derived_from).toBeNull();
    expect(body.relations).toEqual({ derived_from: null, derived_contracts: [] });
    expect((await json(await getOne(req('GET'), ctx(id)))).relations.derived_contracts).toEqual([]);
  });

  it('別的組織、不存在、格式錯誤的 ID 回同一個 404，什麼都沒複製', async () => {
    actAs(kit.orgB);
    const { id: bId } = await newContract();
    actAs(kit.orgA);
    for (const id of [bId, newUlid(), 'abc']) expect(await snap(await copy(req('POST'), ctx(id)))).toEqual(NOT_FOUND);
    expect((await json(await getList())).data).toEqual([]);
    actAs(kit.orgB);
    expect((await json(await getList())).data).toHaveLength(1);
  });
});

describe('GET /api/contracts/[id]/events', () => {
  it('依發生順序回傳歷程（有內容，不是 {}）', async () => {
    const { id } = await newContract();
    await setStatus(id, 'voided');
    const newId = (await json(await copy(req('POST'), ctx(id)))).data.id;

    const events = (await json(await getEvents(req('GET'), ctx(id)))).data;
    expect(events.map((e: { type: string }) => e.type)).toEqual(['created', 'copied']);
    const newEvents = (await json(await getEvents(req('GET'), ctx(newId)))).data;
    expect(newEvents).toEqual([
      expect.objectContaining({ type: 'created', actor: 'landlord', note: `衍生自合約 #${id.slice(-6)}（撤回後修約）` }),
    ]);
  });

  it('別的組織與不存在的合約回同一個 404', async () => {
    actAs(kit.orgB);
    const { id: bId } = await newContract();
    actAs(kit.orgA);
    expect(await snap(await getEvents(req('GET'), ctx(bId)))).toEqual(NOT_FOUND);
    expect(await snap(await getEvents(req('GET'), ctx(newUlid())))).toEqual(NOT_FOUND);
  });
});

describe('/api/contracts/[id]/files', () => {
  it('GET：草稿沒有文件，回 { data: [] }', async () => {
    const { id } = await newContract();
    const res = await getFiles(req('GET'), ctx(id));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: [] });
  });

  it('GET：別的組織與不存在的合約回同一個 404', async () => {
    actAs(kit.orgB);
    const { id: bId } = await newContract();
    actAs(kit.orgA);
    expect(await snap(await getFiles(req('GET'), ctx(bId)))).toEqual(NOT_FOUND);
    expect(await snap(await getFiles(req('GET'), ctx(newUlid())))).toEqual(NOT_FOUND);
  });

  it('POST 補抓：合約尚未完成簽署回 409 與訊息；別的組織回 404', async () => {
    const { id } = await newContract();
    expect(await snap(await refetchFiles(req('POST'), ctx(id)))).toEqual({
      status: 409,
      body: JSON.stringify({ error: '合約尚未完成簽署，沒有可保存的文件' }),
    });
    actAs(kit.orgB);
    expect(await snap(await refetchFiles(req('POST'), ctx(id)))).toEqual(NOT_FOUND);
    expect(await snap(await refetchFiles(req('POST'), ctx('abc')))).toEqual(NOT_FOUND);
  });
});

describe('刪除物件時有合約（ADR-0025 決議 14）', () => {
  it('物件有合約回 409「只能封存」，物件與合約都還在；合約刪掉後可以刪物件', async () => {
    const { id, propertyId } = await newContract();
    const res = await deleteProperty(req('DELETE'), ctx(propertyId));
    expect(await snap(res)).toEqual({ status: 409, body: JSON.stringify({ error: '物件已有合約，不能刪除，只能封存' }) });
    expect((await getOne(req('GET'), ctx(id))).status).toBe(200);

    await DELETE(req('DELETE'), ctx(id));
    const ok = await deleteProperty(req('DELETE'), ctx(propertyId));
    expect(await json(ok)).toEqual({ data: { id: propertyId } });
  });
});
