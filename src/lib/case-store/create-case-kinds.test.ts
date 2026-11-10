import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTx } from '../pg/database';
import { setupRouteDb, TEST_PARTY_ID, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { CaseCreationBlocked, createLeaseCase, getCase, listCaseEvents, listCaseSummaries, type NewLeaseCaseInput } from './index';

// 建立租賃、包租、轉租案件的資料層行為（MIL-195，ADR-0030）。連線是 PGlite 的 app_rw，RLS 生效。
// 接縫是 createLeaseCase 與 getCase 的公開介面。包租案件指屋主租給包租業者那一份，
// 轉租案件是舊業務類型 master_lease（見 src/lib/cases/case-kind.ts）。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

interface Unit {
  unitId: string;
  propertyOf: (orgId: string) => NewLeaseCaseInput['property'];
}

let unit: Unit;
const VERIFIED = { entityStatus: 'verified', hasSignableManager: true } as const;

beforeEach(async () => {
  await kit.reset();
  // 兩個組織共用一個租賃單位（同一間房子）：A 是包租業者，B 是別家公司
  const unitId = newUlid();
  const anchorId = newUlid();
  await withTx({ kind: 'org', orgId: kit.orgA }, (tx) => tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [anchorId, unitId, '某地址']));
  const propertyIds = new Map<string, string>();
  for (const orgId of [kit.orgA, kit.orgB]) {
    const propertyId = newUlid();
    propertyIds.set(orgId, propertyId);
    await withTx({ kind: 'org', orgId }, (tx) =>
      tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [propertyId, orgId, unitId, '物件', '某地址']),
    );
  }
  unit = { unitId, propertyOf: (orgId) => ({ id: propertyIds.get(orgId)!, name: '物件', address: '某地址', rental_unit_id: unitId }) };
});

const NOW = new Date('2026-11-10T02:00:00Z');

const practiceInput = (orgId: string, overrides: Partial<NewLeaseCaseInput>): NewLeaseCaseInput => ({
  orgId,
  orgKind: 'practice',
  businessType: 'self_managed',
  lessorPartyId: TEST_PARTY_ID,
  property: unit.propertyOf(orgId),
  practice: VERIFIED,
  ...overrides,
});

const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);

const activate = (orgId: string, caseId: string) =>
  inOrg(orgId, (tx) => tx.query(`UPDATE org.cases SET state = 'active' WHERE id = $1`, [caseId]));

describe('createLeaseCase：案件種類', () => {
  it('屋主組織建自管案件：歸為租賃案件', async () => {
    const id = await inOrg(kit.orgA, (tx) =>
      createLeaseCase(tx, { orgId: kit.orgA, orgKind: 'owner', businessType: 'self_managed', lessorPartyId: TEST_PARTY_ID, property: unit.propertyOf(kit.orgA) }, NOW),
    );
    const record = await inOrg(kit.orgA, (tx) => getCase(tx, id));
    expect(record).toMatchObject({ kind: 'lease', caseKind: 'lease', businessType: 'self_managed', linkedMasterLeaseCaseId: null });
  });

  it('舊精靈：屋主組織建自管案件，分流條件說承租人是包租業者，歸為包租案件', async () => {
    const id = await inOrg(kit.orgA, (tx) =>
      createLeaseCase(
        tx,
        { orgId: kit.orgA, orgKind: 'owner', businessType: 'self_managed', lesseeIsMasterLessor: true, lessorPartyId: TEST_PARTY_ID, property: unit.propertyOf(kit.orgA) },
        NOW,
      ),
    );
    const record = await inOrg(kit.orgA, (tx) => getCase(tx, id));
    expect(record).toMatchObject({ caseKind: 'master_lease', businessType: 'self_managed', kind: 'lease' });
  });

  it('舊精靈的旗標不影響代管案件', async () => {
    await expect(
      inOrg(kit.orgA, (tx) =>
        createLeaseCase(tx, { orgId: kit.orgA, orgKind: 'owner', businessType: 'managed', lesseeIsMasterLessor: true, lessorPartyId: TEST_PARTY_ID, property: unit.propertyOf(kit.orgA) }, NOW),
      ),
    ).rejects.toBeInstanceOf(CaseCreationBlocked);
  });

  it('屋主組織明傳 master_lease 且沒有過渡旗標：擋下', async () => {
    await expect(
      inOrg(kit.orgA, (tx) =>
        createLeaseCase(tx, { orgId: kit.orgA, orgKind: 'owner', businessType: 'self_managed', caseKind: 'master_lease', lessorPartyId: TEST_PARTY_ID, property: unit.propertyOf(kit.orgA) }, NOW),
      ),
    ).rejects.toThrow(/執業主體組織建立/);
  });

  it('包租業者的組織建包租案件：歸為包租案件，事件記案件種類', async () => {
    const id = await inOrg(kit.orgA, (tx) => createLeaseCase(tx, practiceInput(kit.orgA, { caseKind: 'master_lease' }), NOW));
    const [record, events] = await inOrg(kit.orgA, async (tx) => [await getCase(tx, id), await listCaseEvents(tx, id)] as const);
    expect(record).toMatchObject({ caseKind: 'master_lease', businessType: 'self_managed', state: 'draft' });
    expect(events[0]).toMatchObject({ type: 'created', payload: { caseKind: 'master_lease' } });
  });

  it('清單的每一列帶案件種類', async () => {
    await inOrg(kit.orgA, (tx) => createLeaseCase(tx, practiceInput(kit.orgA, { caseKind: 'master_lease' }), NOW));
    const rows = await inOrg(kit.orgA, (tx) => listCaseSummaries(tx));
    expect(rows.map((r) => r.caseKind)).toEqual(['master_lease']);
  });
});

describe('createLeaseCase：轉租案件必須連到涵蓋這個租賃單位的有效包租案件', () => {
  const sublease = (orgId: string) => practiceInput(orgId, { businessType: 'master_lease', caseKind: 'sublease', ownerPartyId: null });

  async function activeMasterLease(orgId: string): Promise<string> {
    const id = await inOrg(orgId, (tx) => createLeaseCase(tx, practiceInput(orgId, { caseKind: 'master_lease' }), NOW));
    await activate(orgId, id);
    return id;
  }

  const blockedMessage = async (orgId: string): Promise<string> => {
    try {
      await inOrg(orgId, (tx) => createLeaseCase(tx, sublease(orgId), NOW));
    } catch (error) {
      expect(error).toBeInstanceOf(CaseCreationBlocked);
      return (error as Error).message;
    }
    throw new Error('預期被擋下，但建立成功');
  };

  it('有 active 的包租案件涵蓋這個租賃單位：建立成功，記下連結', async () => {
    const masterId = await activeMasterLease(kit.orgA);
    const id = await inOrg(kit.orgA, (tx) => createLeaseCase(tx, sublease(kit.orgA), NOW));
    const [record, events] = await inOrg(kit.orgA, async (tx) => [await getCase(tx, id), await listCaseEvents(tx, id)] as const);
    expect(record).toMatchObject({ caseKind: 'sublease', businessType: 'master_lease', linkedMasterLeaseCaseId: masterId });
    expect(events[0].payload).toMatchObject({ caseKind: 'sublease', linkedMasterLeaseCaseId: masterId });
  });

  it('不傳案件種類，只傳舊的業務類型 master_lease：照樣要連到包租案件', async () => {
    await expect(
      inOrg(kit.orgA, (tx) => createLeaseCase(tx, practiceInput(kit.orgA, { businessType: 'master_lease' }), NOW)),
    ).rejects.toBeInstanceOf(CaseCreationBlocked);
    await activeMasterLease(kit.orgA);
    const id = await inOrg(kit.orgA, (tx) => createLeaseCase(tx, practiceInput(kit.orgA, { businessType: 'master_lease' }), NOW));
    expect((await inOrg(kit.orgA, (tx) => getCase(tx, id)))?.caseKind).toBe('sublease');
  });

  it('沒有包租案件：拒絕，沒有留下任何案件', async () => {
    await expect(inOrg(kit.orgA, (tx) => createLeaseCase(tx, sublease(kit.orgA), NOW))).rejects.toThrow(/有效的包租案件/);
    expect(await inOrg(kit.orgA, (tx) => listCaseSummaries(tx))).toEqual([]);
  });

  it('包租案件還是草稿（不是 active）：拒絕', async () => {
    await inOrg(kit.orgA, (tx) => createLeaseCase(tx, practiceInput(kit.orgA, { caseKind: 'master_lease' }), NOW));
    await expect(inOrg(kit.orgA, (tx) => createLeaseCase(tx, sublease(kit.orgA), NOW))).rejects.toBeInstanceOf(CaseCreationBlocked);
  });

  it('包租案件涵蓋的是別的租賃單位：拒絕', async () => {
    await activeMasterLease(kit.orgA);
    const otherUnit = newUlid();
    await inOrg(kit.orgA, (tx) => tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [newUlid(), otherUnit, '另一地址']));
    const propertyId = newUlid();
    await inOrg(kit.orgA, (tx) =>
      tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [propertyId, kit.orgA, otherUnit, '另一物件', '另一地址']),
    );
    const input = { ...sublease(kit.orgA), property: { id: propertyId, name: '另一物件', address: '另一地址', rental_unit_id: otherUnit } };
    await expect(inOrg(kit.orgA, (tx) => createLeaseCase(tx, input, NOW))).rejects.toBeInstanceOf(CaseCreationBlocked);
  });

  it('別的組織有 active 的包租案件：拒絕，訊息與「沒有包租案件」逐字相同，不洩漏別的組織有沒有', async () => {
    const withNothing = await blockedMessage(kit.orgA);
    await activeMasterLease(kit.orgB);
    const withForeign = await blockedMessage(kit.orgA);
    expect(withForeign).toBe(withNothing);
    expect(await inOrg(kit.orgA, (tx) => listCaseSummaries(tx))).toEqual([]);
  });

  it('別的組織的包租案件不能被連結（資料庫的複合外鍵也擋下）', async () => {
    const foreignId = await activeMasterLease(kit.orgB);
    const mine = await inOrg(kit.orgA, (tx) => createLeaseCase(tx, practiceInput(kit.orgA, { caseKind: 'master_lease' }), NOW));
    await activate(kit.orgA, mine);
    const subId = await inOrg(kit.orgA, (tx) => createLeaseCase(tx, sublease(kit.orgA), NOW));
    await expect(
      inOrg(kit.orgA, (tx) => tx.query(`UPDATE org.cases SET linked_master_lease_case_id = $2 WHERE id = $1`, [subId, foreignId])),
    ).rejects.toThrow(/cases_linked_master_lease_fk|foreign key/);
  });

  it('屋主組織不得建轉租案件', async () => {
    await activeMasterLease(kit.orgA);
    const input = { ...sublease(kit.orgA), orgKind: 'owner' as const };
    await expect(inOrg(kit.orgA, (tx) => createLeaseCase(tx, input, NOW))).rejects.toBeInstanceOf(CaseCreationBlocked);
  });

  it('業別未驗證：拒絕', async () => {
    await activeMasterLease(kit.orgA);
    const input = { ...sublease(kit.orgA), practice: { entityStatus: 'pending', hasSignableManager: true } as const };
    await expect(inOrg(kit.orgA, (tx) => createLeaseCase(tx, input, NOW))).rejects.toThrow(/業別/);
  });
});
