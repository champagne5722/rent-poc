import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSchema, getContract, setDb } from '@/lib/db';
import { actAs, setupRouteDb, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import { POST as createProperty } from '../properties/route';
import { POST } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-81：物件在 PostgreSQL、合約還在 SQLite 的過渡期。POST /api/contracts 從物件帶入快照建草稿。

let kit: RouteDb;
let sqlite: Database.Database;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
  sqlite = new Database(':memory:');
  ensureSchema(sqlite);
  setDb(sqlite);
});
afterEach(() => {
  setDb(null);
  sqlite.close();
});

const createContract = (propertyId: unknown) =>
  POST(new NextRequest('http://localhost/api/contracts', { method: 'POST', body: JSON.stringify({ property_id: propertyId }) }));

async function newProperty(): Promise<string> {
  const res = await createProperty(
    new NextRequest('http://localhost/api/properties', {
      method: 'POST',
      body: JSON.stringify({ name: '大安區溫馨兩房', address: '台北市大安區某路 1 號', default_rent: 20000, equipment: [{ name: '冷氣', quantity: 1 }] }),
    }),
  );
  return ((await res.json()) as { data: { id: string } }).data.id;
}

describe('POST /api/contracts', () => {
  it('從物件建草稿：回 201 與合約編號，物件資料帶入成快照，property_id 存物件的 ULID', async () => {
    const propertyId = await newProperty();
    const res = await createContract(propertyId);
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: number } };
    const contract = getContract(data.id)!;
    expect(contract.property_id).toBe(propertyId);
    expect(contract.fields).toMatchObject({
      propertyName: '大安區溫馨兩房',
      propertyAddress: '台北市大安區某路 1 號',
      rent: 20000,
      deposit: 40000,
      equipmentAnnex: [{ name: '冷氣', quantity: 1, repair: 'landlord', note: '' }],
    });
  });

  it('別的組織的物件、不存在的物件、格式錯誤的 ID，回應逐位元相同', async () => {
    actAs(kit.orgB);
    const bProperty = await newProperty();
    actAs(kit.orgA);
    const snap = async (id: unknown) => {
      const res = await createContract(id);
      return { status: res.status, body: await res.text() };
    };
    const cross = await snap(bProperty);
    expect(cross).toEqual({ status: 400, body: JSON.stringify({ error: '請指定有效的物件' }) });
    expect(await snap(newUlid())).toEqual(cross);
    for (const bad of [3, '3', 'abc', null, undefined]) expect(await snap(bad)).toEqual(cross);
    expect(sqlite.prepare('SELECT count(*) AS n FROM contracts').get()).toEqual({ n: 0 });
  });
});
