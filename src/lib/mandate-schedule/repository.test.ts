import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContract, deleteDraftContract } from '../contracts';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import type { OrgTx } from '../pg/with-tx';
import type { ContractFields } from '../types';
import { copyMandateItems, getMandateItems, replaceMandateItems } from './repository';
import type { MandateItem } from './index';

// PGlite（app_rw），組織 A 與 B 各一份。介面第一個參數是 tx，合約 ID 是 ULID。

let kit: RouteDb;
let contractId: string;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);
const inB = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgB }, fn);
const newDraft = (run: typeof inA = inA) =>
  run((tx) => createContract(tx, { property_id: null, fields: {} as ContractFields, contract_type: 'management' }));

beforeEach(async () => {
  await kit.reset();
  contractId = await newDraft();
});

const ITEMS: MandateItem[] = [
  { propertyId: '7', propertyName: '信義小宅', propertyAddress: '台北市信義區松仁路 1 號', scopes: ['rent_collection', 'repair'] },
  { propertyId: '9', propertyName: '大安套房', propertyAddress: '台北市大安區和平東路 2 號', scopes: ['handover'] },
];

describe('委託標的清單的 repository：第一個參數是 tx，ID 是字串', () => {
  it('沒有清單時回空陣列', async () => {
    expect(await inA((tx) => getMandateItems(tx, contractId))).toEqual([]);
  });

  it('存入後依列順序讀回，範圍依固定順序', async () => {
    await inA((tx) => replaceMandateItems(tx, contractId, [{ ...ITEMS[0], scopes: ['repair', 'rent_collection'] }, ITEMS[1]]));
    expect(await inA((tx) => getMandateItems(tx, contractId))).toEqual([
      { ...ITEMS[0], scopes: ['rent_collection', 'repair'] },
      ITEMS[1],
    ]);
  });

  it('再存一次是整批取代，不留舊的列', async () => {
    await inA((tx) => replaceMandateItems(tx, contractId, ITEMS));
    await inA((tx) => replaceMandateItems(tx, contractId, [ITEMS[1]]));
    expect(await inA((tx) => getMandateItems(tx, contractId))).toEqual([ITEMS[1]]);
    await inA((tx) => replaceMandateItems(tx, contractId, []));
    expect(await inA((tx) => getMandateItems(tx, contractId))).toEqual([]);
  });

  it('同一個租賃單位出現兩列時整批拒絕，原本的清單不變', async () => {
    await inA((tx) => replaceMandateItems(tx, contractId, [ITEMS[0]]));
    await expect(inA((tx) => replaceMandateItems(tx, contractId, [ITEMS[1], ITEMS[1]]))).rejects.toThrow();
    expect(await inA((tx) => getMandateItems(tx, contractId))).toEqual([ITEMS[0]]);
  });

  it('複製為新草稿時一併複製清單，來源不受影響', async () => {
    await inA((tx) => replaceMandateItems(tx, contractId, ITEMS));
    const other = await newDraft();
    await inA((tx) => copyMandateItems(tx, contractId, other));
    expect(await inA((tx) => getMandateItems(tx, other))).toEqual(ITEMS);
    expect(await inA((tx) => getMandateItems(tx, contractId))).toEqual(ITEMS);
  });

  it('刪除草稿時清單一併刪除', async () => {
    await inA((tx) => replaceMandateItems(tx, contractId, ITEMS));
    expect(await inA((tx) => deleteDraftContract(tx, contractId))).toBe('deleted');
    expect(await inA((tx) => getMandateItems(tx, contractId))).toEqual([]);
  });
});

describe('組織隔離', () => {
  it('B 組織讀不到 A 組織合約的清單', async () => {
    await inA((tx) => replaceMandateItems(tx, contractId, ITEMS));
    expect(await inB((tx) => getMandateItems(tx, contractId))).toEqual([]);
  });

  it('B 組織不能對 A 組織的合約寫入清單（複合外鍵擋下）', async () => {
    await expect(inB((tx) => replaceMandateItems(tx, contractId, ITEMS))).rejects.toThrow();
    expect(await inA((tx) => getMandateItems(tx, contractId))).toEqual([]);
  });
});
