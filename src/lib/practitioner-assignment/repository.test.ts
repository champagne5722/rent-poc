import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteContractWithEvents, ensureSchema, insertContractWithEvent } from '../db';
import {
  copyAssignments,
  getAssignments,
  replaceAssignments,
} from './repository';

let db: Database.Database;
let contractId: number;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  contractId = insertContractWithEvent({ property_id: null, fields: '{}' }, { type: 'created', actor: 'landlord' }, db);
});
afterEach(() => db.close());

const SLOT = 'lease.master_lease.practitioner';

describe('指派的 repository：介面回傳 Promise，ID 是字串', () => {
  it('沒有指派時回空陣列', async () => {
    expect(await getAssignments(contractId, db)).toEqual([]);
  });

  it('存入後讀回', async () => {
    await replaceAssignments(
      contractId,
      [{ slot: SLOT, entityId: 'org-pe-beichen', practitionerId: 'pr-chen', partySignerId: 'ps-wang' }],
      db,
    );
    expect(await getAssignments(contractId, db)).toEqual([
      expect.objectContaining({ slot: SLOT, entityId: 'org-pe-beichen', practitionerId: 'pr-chen', partySignerId: 'ps-wang' }),
    ]);
  });

  it('再存一次是整批取代：改派與取消都不留舊資料', async () => {
    await replaceAssignments(contractId, [{ slot: SLOT, entityId: 'a', practitionerId: 'p1', partySignerId: null }], db);
    await replaceAssignments(contractId, [{ slot: SLOT, entityId: 'b', practitionerId: 'p2', partySignerId: 's' }], db);
    expect((await getAssignments(contractId, db)).map((a) => a.practitionerId)).toEqual(['p2']);
    await replaceAssignments(contractId, [], db);
    expect(await getAssignments(contractId, db)).toEqual([]);
  });

  it('一個席位只有一列，重複的席位拒絕整批寫入', async () => {
    const dup = [
      { slot: SLOT, entityId: 'a', practitionerId: 'p1', partySignerId: null },
      { slot: SLOT, entityId: 'a', practitionerId: 'p2', partySignerId: null },
    ];
    await expect(replaceAssignments(contractId, dup, db)).rejects.toThrow();
    expect(await getAssignments(contractId, db)).toEqual([]);
  });

  it('複製為新草稿時一併複製指派，來源不受影響', async () => {
    await replaceAssignments(contractId, [{ slot: SLOT, entityId: 'a', practitionerId: 'p1', partySignerId: 's' }], db);
    const other = insertContractWithEvent({ property_id: null, fields: '{}' }, { type: 'created', actor: 'landlord' }, db);
    await copyAssignments(contractId, other, db);
    expect(await getAssignments(other, db)).toEqual([
      expect.objectContaining({ slot: SLOT, practitionerId: 'p1', partySignerId: 's' }),
    ]);
    expect(await getAssignments(contractId, db)).toHaveLength(1);
  });

  it('刪除草稿時指派一起刪除', async () => {
    await replaceAssignments(contractId, [{ slot: SLOT, entityId: 'a', practitionerId: 'p1', partySignerId: null }], db);
    deleteContractWithEvents(contractId, db);
    expect(await getAssignments(contractId, db)).toEqual([]);
  });
});
