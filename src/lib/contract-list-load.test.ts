import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as createContractRoute } from '@/app/api/contracts/route';
import { POST as createProperty } from '@/app/api/properties/route';
import { actAs, actAsParty, actAsError, setupRouteDb, type RouteDb } from '@/lib/pg/route-test-kit';
import { Unauthenticated } from '@/lib/request-context';
import { loadContractList } from './contract-list-load';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// 合約列表頁在 server component 載入資料（MIL-174）。載入函式與 GET /api/contracts 看到同一份資料。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
});

async function newContract(): Promise<string> {
  return (await newContractWithProperty()).contractId;
}

async function newContractWithProperty(): Promise<{ contractId: string; propertyId: string }> {
  const property = await createProperty(
    new NextRequest('http://localhost/api/properties', {
      method: 'POST',
      body: JSON.stringify({ name: '大安區溫馨兩房', address: '台北市大安區某路 1 號', default_rent: 20000, equipment: [] }),
    }),
  );
  const propertyId = ((await property.json()) as { data: { id: string } }).data.id;
  const res = await createContractRoute(
    new NextRequest('http://localhost/api/contracts', { method: 'POST', body: JSON.stringify({ property_id: propertyId }) }),
  );
  return { contractId: ((await res.json()) as { data: { id: string } }).data.id, propertyId };
}

describe('loadContractList', () => {
  it('沒有合約時回空清單與空進度', async () => {
    expect(await loadContractList()).toEqual({ kind: 'ok', contracts: [], progress: {}, displayCodes: {} });
  });

  it('列出自己組織的合約，新的在前；草稿沒有簽署進度', async () => {
    const first = await newContract();
    const second = await newContract();
    const result = await loadContractList();
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.contracts.map((c) => c.id)).toEqual([second, first]);
    expect(result.contracts[0]).toMatchObject({ status: 'draft', contract_type: 'lease' });
    expect(result.progress).toEqual({});
  });

  it('別的組織的合約不會出現', async () => {
    actAs(kit.orgB);
    await newContract();
    actAs(kit.orgA);
    expect(await loadContractList()).toEqual({ kind: 'ok', contracts: [], progress: {}, displayCodes: {} });
  });

  it('帶回合約所屬物件的顯示編碼，以物件 ID 為鍵', async () => {
    const { propertyId } = await newContractWithProperty();
    const result = await loadContractList();
    if (result.kind !== 'ok') throw new Error('應該載入成功');
    // 新建的物件是待驗證錨點，補建號前沒有顯示編碼（null），但仍在對照表裡
    expect(result.displayCodes).toEqual({ [propertyId]: null });
  });

  it('不是組織身分時回 forbidden，不丟錯', async () => {
    actAsParty();
    expect(await loadContractList()).toEqual({ kind: 'forbidden' });
  });

  it('沒登入時丟 Unauthenticated，讓頁面導向登入', async () => {
    actAsError(new Unauthenticated());
    await expect(loadContractList()).rejects.toBeInstanceOf(Unauthenticated);
  });
});
