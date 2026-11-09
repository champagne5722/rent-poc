import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteContractWithEvents, ensureSchema, insertContractWithEvent } from '../db';
import { copyMandateItems, getMandateItems, replaceMandateItems } from './repository';
import type { MandateItem } from './index';

let db: Database.Database;
let contractId: number;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  contractId = insertContractWithEvent(
    { property_id: null, fields: '{}', contract_type: 'management' },
    { type: 'created', actor: 'landlord' },
    db,
  );
});
afterEach(() => db.close());

const ITEMS: MandateItem[] = [
  { propertyId: '7', propertyName: '信義小宅', propertyAddress: '台北市信義區松仁路 1 號', scopes: ['rent_collection', 'repair'] },
  { propertyId: '9', propertyName: '大安套房', propertyAddress: '台北市大安區和平東路 2 號', scopes: ['handover'] },
];

describe('委託標的清單的 repository：介面回傳 Promise，ID 是字串', () => {
  it('沒有清單時回空陣列', async () => {
    expect(await getMandateItems(contractId, db)).toEqual([]);
  });

  it('存入後依列順序讀回，範圍依固定順序', async () => {
    await replaceMandateItems(contractId, [{ ...ITEMS[0], scopes: ['repair', 'rent_collection'] }, ITEMS[1]], db);
    expect(await getMandateItems(contractId, db)).toEqual([
      { ...ITEMS[0], scopes: ['rent_collection', 'repair'] },
      ITEMS[1],
    ]);
  });

  it('再存一次是整批取代，不留舊的列', async () => {
    await replaceMandateItems(contractId, ITEMS, db);
    await replaceMandateItems(contractId, [ITEMS[1]], db);
    expect(await getMandateItems(contractId, db)).toEqual([ITEMS[1]]);
    await replaceMandateItems(contractId, [], db);
    expect(await getMandateItems(contractId, db)).toEqual([]);
  });

  it('同一個租賃單位出現兩列時整批拒絕，原本的清單不變', async () => {
    await replaceMandateItems(contractId, [ITEMS[0]], db);
    await expect(replaceMandateItems(contractId, [ITEMS[1], ITEMS[1]], db)).rejects.toThrow();
    expect(await getMandateItems(contractId, db)).toEqual([ITEMS[0]]);
  });

  it('複製為新草稿時一併複製清單，來源不受影響', async () => {
    await replaceMandateItems(contractId, ITEMS, db);
    const other = insertContractWithEvent(
      { property_id: null, fields: '{}', contract_type: 'management' },
      { type: 'created', actor: 'landlord' },
      db,
    );
    await copyMandateItems(contractId, other, db);
    expect(await getMandateItems(other, db)).toEqual(ITEMS);
    expect(await getMandateItems(contractId, db)).toEqual(ITEMS);
  });

  it('刪除草稿時清單一併刪除', async () => {
    await replaceMandateItems(contractId, ITEMS, db);
    deleteContractWithEvents(contractId, db);
    expect(await getMandateItems(contractId, db)).toEqual([]);
  });
});
