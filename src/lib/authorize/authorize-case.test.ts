import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findOrCreateParty, insertCase, insertCaseMember } from '../case-store';
import { withTx } from '../pg/database';
import { setupRouteDb, TEST_PARTY_ID, TEST_USER_ID, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { OrgRole, RequestContext } from '../request-context';
import type { BusinessType, CaseState } from '../cases';
import { authorize, authorizeIgnoringState, bindAccessContext, Forbidden } from './index';

// authorize() 對案件物件與有案件的合約（MIL-115 接線）。連線是 PGlite 的 app_rw，RLS 生效。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const NOW = new Date('2026-01-01T00:00:00.000Z');

const orgContext = (orgId: string, role: OrgRole, partyId = TEST_PARTY_ID): Extract<RequestContext, { kind: 'org' }> => ({
  kind: 'org',
  orgId,
  orgKind: 'owner',
  userId: TEST_USER_ID,
  partyId,
  role,
  requestId: 't',
});

function asRole_<R>(orgId: string, role: OrgRole, fn: (tx: Parameters<typeof authorize>[0]) => Promise<R>, partyId = TEST_PARTY_ID): Promise<R> {
  const rc = orgContext(orgId, role, partyId);
  return withTx({ kind: 'org', orgId, partyId }, (tx) => {
    bindAccessContext(tx, rc);
    return fn(tx);
  });
}

async function seedCase(state: CaseState, businessType: BusinessType = 'self_managed') {
  return withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
    const caseId = newUlid();
    await insertCase(
      tx,
      { kind: 'lease', id: caseId, orgId: kit.orgA, state: 'draft', stateVersion: 0, currentContractId: null, businessType, rentalUnitId: '', linkedMandateCaseId: null, predecessorCaseId: null, handoverId: null },
      { title: 'x', propertyId: null, rentalUnitId: null },
      NOW,
    );
    await tx.query('UPDATE org.cases SET state = $2 WHERE id = $1', [caseId, state]);
    const contractId = newUlid();
    await tx.query('INSERT INTO org.contracts (id, org_id, case_id) VALUES ($1, $2, $3)', [contractId, kit.orgA, caseId]);
    return { caseId, contractId };
  });
}

const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(Forbidden);
    return (error as Forbidden).reason;
  }
  throw new Error('預期丟 Forbidden，但通過了');
};

describe('authorize：案件物件，主辦組織成員', () => {
  it.each(['admin', 'staff', 'viewer'] as const)('%s 讀案件成功，走 host_org 路徑', async (role) => {
    const { caseId } = await seedCase('active');
    const grant = await asRole_(kit.orgA, role, (tx) => authorize(tx, 'case.read_summary', { type: 'case', id: caseId }));
    expect(grant).toEqual({ via: 'host_org', onBehalf: false });
  });

  it('admin 與 staff 能管理成員；viewer 被拒', async () => {
    const { caseId } = await seedCase('draft');
    await expect(asRole_(kit.orgA, 'staff', (tx) => authorize(tx, 'case_member.manage', { type: 'case', id: caseId }))).resolves.toBeDefined();
    expect(await reasonOf(asRole_(kit.orgA, 'viewer', (tx) => authorize(tx, 'case_member.manage', { type: 'case', id: caseId })))).toBe('viewer_read_only');
  });

  it('別的組織與不存在的案件，原因相同（object_not_found）', async () => {
    const { caseId } = await seedCase('active');
    const other = await reasonOf(asRole_(kit.orgB, 'admin', (tx) => authorize(tx, 'case.read_summary', { type: 'case', id: caseId })));
    const missing = await reasonOf(asRole_(kit.orgA, 'admin', (tx) => authorize(tx, 'case.read_summary', { type: 'case', id: newUlid() })));
    expect([other, missing]).toEqual(['object_not_found', 'object_not_found']);
  });

  it('終態唯讀：結案的案件讀得到，管理成員被拒（case_closed_read_only）', async () => {
    const { caseId } = await seedCase('closed');
    await expect(asRole_(kit.orgA, 'admin', (tx) => authorize(tx, 'case.read_summary', { type: 'case', id: caseId }))).resolves.toBeDefined();
    expect(await reasonOf(asRole_(kit.orgA, 'admin', (tx) => authorize(tx, 'case_member.manage', { type: 'case', id: caseId })))).toBe('case_closed_read_only');
  });

  it('代管案件的代操作動作：委託事實尚未載入，一律拒絕（no_mandate_link），不放行', async () => {
    const { caseId } = await seedCase('active', 'managed');
    expect(await reasonOf(asRole_(kit.orgA, 'admin', (tx) => authorize(tx, 'ledger.record_payment', { type: 'case', id: caseId })))).toBe('no_mandate_link');
    // 非代操作動作不受影響
    await expect(asRole_(kit.orgA, 'admin', (tx) => authorize(tx, 'case.read_summary', { type: 'case', id: caseId }))).resolves.toBeDefined();
  });

  it('清單動作 case.list：所有角色', async () => {
    for (const role of ['admin', 'staff', 'viewer'] as const) {
      await expect(asRole_(kit.orgA, role, (tx) => authorize(tx, 'case.list', { type: 'org' }))).resolves.toEqual({ via: 'org_role', onBehalf: false });
    }
  });
});

describe('authorize：案件成員（屋主在自己的組織身分，案件在別的組織）', () => {
  async function ownerOfCase(relation: 'lessor' | 'owner') {
    const { caseId, contractId } = await seedCase('active');
    const partyId = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
      const id = await findOrCreateParty(tx, `${relation}@example.com`, relation);
      await insertCaseMember(tx, caseId, { partyId: id, relation }, NOW);
      return id;
    });
    return { caseId, contractId, partyId };
  }

  it('lessor 讀案件成功，走 case_relation 路徑，不必加入主辦組織', async () => {
    const { caseId, partyId } = await ownerOfCase('lessor');
    const grant = await asRole_(kit.orgB, 'admin', (tx) => authorize(tx, 'case.read_summary', { type: 'case', id: caseId }), partyId);
    expect(grant).toEqual({ via: 'case_relation', onBehalf: false });
  });

  it('不是成員就讀不到：object_not_found', async () => {
    const { caseId } = await seedCase('active');
    expect(await reasonOf(asRole_(kit.orgB, 'admin', (tx) => authorize(tx, 'case.read_summary', { type: 'case', id: caseId }), newUlid()))).toBe('object_not_found');
  });

  it('合約物件只認主辦組織：別的組織的成員以合約 ID 取用，當作不存在', async () => {
    const { contractId, partyId } = await ownerOfCase('lessor');
    expect(await reasonOf(asRole_(kit.orgB, 'admin', (tx) => authorize(tx, 'contract.read', { type: 'contract', id: contractId }), partyId))).toBe('object_not_found');
  });
});

describe('authorize：有案件的合約', () => {
  it('案件 draft：送簽通過；案件 signing：同一個動作被拒（state_not_allowed）', async () => {
    const draft = await seedCase('draft');
    await expect(asRole_(kit.orgA, 'staff', (tx) => authorize(tx, 'contract.draft_send', { type: 'contract', id: draft.contractId }))).resolves.toBeDefined();
    const signing = await seedCase('signing');
    expect(await reasonOf(asRole_(kit.orgA, 'staff', (tx) => authorize(tx, 'contract.draft_send', { type: 'contract', id: signing.contractId })))).toBe('state_not_allowed');
  });

  it('authorizeIgnoringState：案件狀態不符回 null，其他拒絕照舊丟 Forbidden', async () => {
    const signing = await seedCase('signing');
    const object = { type: 'contract', id: signing.contractId } as const;
    expect(await asRole_(kit.orgA, 'staff', (tx) => authorizeIgnoringState(tx, 'contract.draft_send', object))).toBeNull();
    expect(await reasonOf(asRole_(kit.orgA, 'viewer', (tx) => authorizeIgnoringState(tx, 'contract.draft_send', object)))).toBe('viewer_read_only');
    expect(await reasonOf(asRole_(kit.orgB, 'admin', (tx) => authorizeIgnoringState(tx, 'contract.draft_send', object)))).toBe('object_not_found');
    const closed = await seedCase('closed');
    expect(await reasonOf(asRole_(kit.orgA, 'admin', (tx) => authorizeIgnoringState(tx, 'contract.draft_send', { type: 'contract', id: closed.contractId })))).toBe('case_closed_read_only');
  });

  it('沒有案件的合約仍走組織角色（uncased）', async () => {
    const id = newUlid();
    await withTx({ kind: 'org', orgId: kit.orgA }, (tx) => tx.query('INSERT INTO org.contracts (id, org_id) VALUES ($1, $2)', [id, kit.orgA]));
    await expect(asRole_(kit.orgA, 'staff', (tx) => authorize(tx, 'contract.draft_send', { type: 'contract', id }))).resolves.toBeDefined();
  });
});
