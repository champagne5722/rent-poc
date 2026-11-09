import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContract, deleteDraftContract } from '../contracts';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import type { OrgTx } from '../pg/with-tx';
import type { ContractFields } from '../types';
import {
  copyAssignments,
  getAssignments,
  replaceAssignments,
} from './repository';

// PGlite（app_rw），組織 A 與 B 各一份。介面第一個參數是 tx，合約 ID 是 ULID。

let kit: RouteDb;
let contractId: string;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);
const inB = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgB }, fn);
const newDraft = (run: typeof inA = inA) => run((tx) => createContract(tx, { property_id: null, fields: {} as ContractFields }));

beforeEach(async () => {
  await kit.reset();
  contractId = await newDraft();
});

const SLOT = 'lease.master_lease.practitioner';

describe('指派的 repository：第一個參數是 tx，ID 是字串', () => {
  it('沒有指派時回空陣列', async () => {
    expect(await inA((tx) => getAssignments(tx, contractId))).toEqual([]);
  });

  it('存入後讀回', async () => {
    await inA((tx) =>
      replaceAssignments(tx, contractId, [
        { slot: SLOT, entityId: 'org-pe-beichen', practitionerId: 'pr-chen', partySignerId: 'ps-wang' },
      ]),
    );
    expect(await inA((tx) => getAssignments(tx, contractId))).toEqual([
      expect.objectContaining({ slot: SLOT, entityId: 'org-pe-beichen', practitionerId: 'pr-chen', partySignerId: 'ps-wang' }),
    ]);
  });

  it('再存一次是整批取代：改派與取消都不留舊資料', async () => {
    await inA((tx) => replaceAssignments(tx, contractId, [{ slot: SLOT, entityId: 'a', practitionerId: 'p1', partySignerId: null }]));
    await inA((tx) => replaceAssignments(tx, contractId, [{ slot: SLOT, entityId: 'b', practitionerId: 'p2', partySignerId: 's' }]));
    expect((await inA((tx) => getAssignments(tx, contractId))).map((a) => a.practitionerId)).toEqual(['p2']);
    await inA((tx) => replaceAssignments(tx, contractId, []));
    expect(await inA((tx) => getAssignments(tx, contractId))).toEqual([]);
  });

  it('一個席位只有一列，重複的席位拒絕整批寫入，原本的指派不變', async () => {
    await inA((tx) => replaceAssignments(tx, contractId, [{ slot: SLOT, entityId: 'keep', practitionerId: 'p0', partySignerId: null }]));
    const dup = [
      { slot: SLOT, entityId: 'a', practitionerId: 'p1', partySignerId: null },
      { slot: SLOT, entityId: 'a', practitionerId: 'p2', partySignerId: null },
    ];
    await expect(inA((tx) => replaceAssignments(tx, contractId, dup))).rejects.toThrow();
    expect((await inA((tx) => getAssignments(tx, contractId))).map((a) => a.practitionerId)).toEqual(['p0']);
  });

  it('複製為新草稿時一併複製指派，來源不受影響', async () => {
    await inA((tx) => replaceAssignments(tx, contractId, [{ slot: SLOT, entityId: 'a', practitionerId: 'p1', partySignerId: 's' }]));
    const other = await newDraft();
    await inA((tx) => copyAssignments(tx, contractId, other));
    expect(await inA((tx) => getAssignments(tx, other))).toEqual([
      expect.objectContaining({ slot: SLOT, practitionerId: 'p1', partySignerId: 's' }),
    ]);
    expect(await inA((tx) => getAssignments(tx, contractId))).toHaveLength(1);
  });

  it('刪除草稿時指派一起刪除', async () => {
    await inA((tx) => replaceAssignments(tx, contractId, [{ slot: SLOT, entityId: 'a', practitionerId: 'p1', partySignerId: null }]));
    expect(await inA((tx) => deleteDraftContract(tx, contractId))).toBe('deleted');
    expect(await inA((tx) => getAssignments(tx, contractId))).toEqual([]);
  });
});

describe('組織隔離', () => {
  it('B 組織讀不到 A 組織合約的指派', async () => {
    await inA((tx) => replaceAssignments(tx, contractId, [{ slot: SLOT, entityId: 'a', practitionerId: 'p1', partySignerId: null }]));
    expect(await inB((tx) => getAssignments(tx, contractId))).toEqual([]);
  });

  it('B 組織不能對 A 組織的合約寫入指派（複合外鍵擋下）', async () => {
    await expect(
      inB((tx) => replaceAssignments(tx, contractId, [{ slot: SLOT, entityId: 'x', practitionerId: 'p9', partySignerId: null }])),
    ).rejects.toThrow();
    expect(await inA((tx) => getAssignments(tx, contractId))).toEqual([]);
  });
});
