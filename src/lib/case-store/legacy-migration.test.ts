import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTx } from '../pg/database';
import { setupRouteDb, TEST_PARTY_ID, TEST_USER_ID, type RouteDb } from '../pg/route-test-kit';
import { createUlidFactory, newUlid } from '../pg/ulid';
import { createProperty, parsePropertyInput } from '../properties';
import { getCase, listCaseEvents, listCaseMembers, migrateContractsToCases, caseStateForContract } from './index';

// 既有合約遷移（ADR-0023 決議 3，MIL-115）。連線是 PGlite 的 app_rw。
// 接縫是 migrateContractsToCases()：舊資料用 SQL 直接寫進去（沒有案件），跑遷移，看案件長什麼樣。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const NOW = new Date('2026-11-09T00:00:00.000Z');
const nextId = (isoTime: string) => createUlidFactory({ now: () => new Date(isoTime).getTime() })();

async function seedProperty(orgId: string): Promise<string> {
  const parsed = parsePropertyInput({ name: '舊物件', address: '台北市中正區某路 1 號', type: '整層住家' });
  if (!parsed.ok) throw new Error(parsed.error);
  return withTx({ kind: 'org', orgId }, (tx) => createProperty(tx, parsed.value));
}

interface LegacyContract {
  id?: string;
  status: string;
  derivedFrom?: string | null;
  propertyId?: string | null;
  fields?: Record<string, unknown>;
  createdAt?: string;
  orgId?: string;
}

async function seedContract(c: LegacyContract): Promise<string> {
  const id = c.id ?? newUlid();
  await withTx({ kind: 'org', orgId: c.orgId ?? kit.orgA }, (tx) =>
    tx.query(
      `INSERT INTO org.contracts (id, org_id, property_id, status, fields, derived_from, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [id, c.orgId ?? kit.orgA, c.propertyId ?? null, c.status, JSON.stringify(c.fields ?? {}), c.derivedFrom ?? null, c.createdAt ?? '2026-03-01T00:00:00Z'],
    ),
  );
  return id;
}

const caseOf = (contractId: string) =>
  withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
    const { rows } = await tx.query<{ case_id: string | null }>('SELECT case_id FROM org.contracts WHERE id = $1', [contractId]);
    const caseId = rows[0]?.case_id ?? null;
    return caseId ? { caseId, record: await getCase(tx, caseId), events: await listCaseEvents(tx, caseId), members: await listCaseMembers(tx, caseId) } : null;
  });

describe('合約狀態 → 案件狀態的對應表', () => {
  it.each([
    ['draft', 'draft'],
    ['awaiting_tenant', 'signing'],
    ['awaiting_landlord', 'signing'],
    ['awaiting_practitioner', 'signing'],
    ['completed', 'active'],
    ['declined', 'draft'],
    ['voided', 'draft'],
  ] as const)('合約 %s → 案件 %s', async (status, expected) => {
    const id = await seedContract({ status });
    await migrateContractsToCases({ now: NOW });
    expect((await caseOf(id))?.record?.state).toBe(expected);
    expect(caseStateForContract(status)).toBe(expected);
  });

  it('拒簽與撤回的合約維持原狀態，案件是 draft', async () => {
    const declined = await seedContract({ status: 'declined' });
    const voided = await seedContract({ status: 'voided' });
    await migrateContractsToCases({ now: NOW });
    const status = (id: string) => withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => (await tx.query<{ status: string }>('SELECT status FROM org.contracts WHERE id = $1', [id])).rows[0].status);
    expect([await status(declined), await status(voided)]).toEqual(['declined', 'voided']);
    expect((await caseOf(declined))?.record?.state).toBe('draft');
    expect((await caseOf(voided))?.record?.state).toBe('draft');
  });
});

describe('migrateContractsToCases', () => {
  it('每份合約一個自管租賃案件：current_contract_id 指向它，版本 0，寫一筆 migrated 事件', async () => {
    const propertyId = await seedProperty(kit.orgA);
    const id = await seedContract({
      status: 'completed',
      propertyId,
      fields: { startDate: '2026-01-01', endDate: '2026-12-31', rent: 18000, tenantEmail: 'T@Example.com', tenantName: '王租客' },
    });
    const result = await migrateContractsToCases({ now: NOW });
    // 3 個屋主組織：測試的 A、B，加上種子的預設組織
    expect(result).toMatchObject({ orgs: 3, casesCreated: 1, contractsLinked: 1, failedOrgs: [] });

    const c = await caseOf(id);
    expect(c?.record).toMatchObject({
      kind: 'lease',
      businessType: 'self_managed',
      state: 'active',
      stateVersion: 0,
      currentContractId: id,
      propertyId,
      title: '舊物件（台北市中正區某路 1 號）',
      leaseStart: '2026-01-01',
      leaseEnd: '2026-12-31',
      monthlyRent: 18000,
    });
    expect(c?.record?.rentalUnitId).toBeTruthy();
    expect(c?.events.map((e) => e.type)).toEqual(['migrated']);
    expect(c?.events[0]).toMatchObject({ toState: 'active', occurredAt: NOW.toISOString(), actorPartyId: null });
  });

  it('承租人依乙方 email 建立 lessee；草稿沒有送出，不建承租人', async () => {
    const sent = await seedContract({ status: 'awaiting_tenant', fields: { tenantEmail: 'Tenant@Example.com', tenantName: '王租客' } });
    const draft = await seedContract({ status: 'draft', fields: { tenantEmail: 'draft@example.com', tenantName: '草稿租客' } });
    await migrateContractsToCases({ now: NOW });
    expect((await caseOf(sent))?.members.find((m) => m.relation === 'lessee')).toMatchObject({ email: 'tenant@example.com', displayName: '王租客' });
    expect((await caseOf(draft))?.members.filter((m) => m.relation === 'lessee')).toEqual([]);
  });

  it('出租人成員是遷移當下的組織 admin', async () => {
    await withTx({ kind: 'control' }, async (tx) => {
      await tx.query(`INSERT INTO control.users (id, party_id) VALUES ($1, $2)`, [TEST_USER_ID, TEST_PARTY_ID]);
      await tx.query(`INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'admin')`, [newUlid(), kit.orgA, TEST_USER_ID]);
    });
    const id = await seedContract({ status: 'draft' });
    await migrateContractsToCases({ now: NOW });
    expect((await caseOf(id))?.members.map((m) => [m.partyId, m.relation])).toEqual([[TEST_PARTY_ID, 'lessor']]);
  });

  it('衍生鏈上的合約歸同一案件，current_contract_id 指向最新一份，案件狀態取最新一份', async () => {
    const first = nextId('2026-01-01T00:00:00Z');
    const second = nextId('2026-02-01T00:00:00Z');
    const third = nextId('2026-03-01T00:00:00Z');
    await seedContract({ id: first, status: 'voided', createdAt: '2026-01-01T00:00:00Z', fields: { tenantEmail: 'a@example.com', tenantName: 'a' } });
    await seedContract({ id: second, status: 'voided', derivedFrom: first, createdAt: '2026-02-01T00:00:00Z', fields: { tenantEmail: 'a@example.com', tenantName: 'a' } });
    await seedContract({ id: third, status: 'draft', derivedFrom: second, createdAt: '2026-03-01T00:00:00Z', fields: { tenantEmail: 'a@example.com', tenantName: 'a' } });
    const result = await migrateContractsToCases({ now: NOW });
    expect(result).toMatchObject({ casesCreated: 1, contractsLinked: 3 });

    const [a, b, c] = await Promise.all([caseOf(first), caseOf(second), caseOf(third)]);
    expect(new Set([a?.caseId, b?.caseId, c?.caseId]).size).toBe(1);
    expect(c?.record).toMatchObject({ currentContractId: third, state: 'draft' });
    // 較早送過簽的承租人仍是成員
    expect(c?.members.filter((m) => m.relation === 'lessee')).toHaveLength(1);
    expect(c?.events).toHaveLength(1);
  });

  it('案件 ID 的時間取自第一份合約的建立時間，案件清單的順序與合約一致', async () => {
    const older = await seedContract({ status: 'draft', createdAt: '2026-01-01T00:00:00Z' });
    const newer = await seedContract({ status: 'draft', createdAt: '2026-06-01T00:00:00Z' });
    await migrateContractsToCases({ now: NOW });
    const [a, b] = await Promise.all([caseOf(older), caseOf(newer)]);
    expect(a!.caseId < b!.caseId).toBe(true);
  });

  it('可重複執行：第二次不新增案件、不新增事件，結果相同', async () => {
    const id = await seedContract({ status: 'completed', fields: { tenantEmail: 'x@example.com', tenantName: 'x' } });
    await migrateContractsToCases({ now: NOW });
    const before = await caseOf(id);
    const second = await migrateContractsToCases({ now: new Date('2026-12-01T00:00:00Z') });
    expect(second).toMatchObject({ casesCreated: 0, contractsLinked: 0 });
    const after = await caseOf(id);
    expect(after).toEqual(before);
  });

  it('遷移後新增的舊式合約只補它自己；已有案件的合約不動', async () => {
    const a = await seedContract({ status: 'draft' });
    await migrateContractsToCases({ now: NOW });
    const caseA = (await caseOf(a))?.caseId;
    const b = await seedContract({ status: 'draft' });
    const second = await migrateContractsToCases({ now: NOW });
    expect(second.casesCreated).toBe(1);
    expect((await caseOf(a))?.caseId).toBe(caseA);
    expect((await caseOf(b))?.caseId).not.toBe(caseA);
  });

  it('衍生合約的前身已有案件：掛進那個案件，目前合約改指向它', async () => {
    const first = nextId('2026-01-01T00:00:00Z');
    await seedContract({ id: first, status: 'voided', createdAt: '2026-01-01T00:00:00Z' });
    await migrateContractsToCases({ now: NOW });
    const later = nextId('2026-05-01T00:00:00Z');
    await seedContract({ id: later, status: 'draft', derivedFrom: first, createdAt: '2026-05-01T00:00:00Z' });
    const result = await migrateContractsToCases({ now: NOW });
    expect(result).toMatchObject({ casesCreated: 0, attachedToExisting: 1 });
    const c = await caseOf(later);
    expect(c?.caseId).toBe((await caseOf(first))?.caseId);
    expect(c?.record?.currentContractId).toBe(later);
  });

  it('組織之間互不影響，各組織的案件在各自的組織', async () => {
    const a = await seedContract({ status: 'draft', orgId: kit.orgA });
    const b = await seedContract({ status: 'draft', orgId: kit.orgB });
    await migrateContractsToCases({ now: NOW });
    const inB = await withTx({ kind: 'org', orgId: kit.orgB }, (tx) => tx.query<{ case_id: string; org_id: string }>('SELECT c.case_id, k.org_id FROM org.contracts c JOIN org.cases k ON k.id = c.case_id WHERE c.id = $1', [b]));
    expect(inB.rows[0].org_id).toBe(kit.orgB);
    expect((await caseOf(a))?.record?.orgId).toBe(kit.orgA);
  });

  it('只處理租賃合約與屋主組織：委託管理合約不建租賃案件，執業主體組織不遷移', async () => {
    const mgmt = newUlid();
    await withTx({ kind: 'org', orgId: kit.orgA }, (tx) =>
      tx.query(`INSERT INTO org.contracts (id, org_id, contract_type) VALUES ($1, $2, 'management')`, [mgmt, kit.orgA]),
    );
    await kit.asOwner((db) => db.query(`UPDATE control.orgs SET kind = 'practice' WHERE id = $1`, [kit.orgB]));
    const practice = await seedContract({ status: 'draft', orgId: kit.orgB });
    const result = await migrateContractsToCases({ now: NOW });
    expect(result.casesCreated).toBe(0);
    for (const [orgId, id] of [[kit.orgA, mgmt], [kit.orgB, practice]] as const) {
      const row = await withTx({ kind: 'org', orgId }, (tx) => tx.query<{ case_id: string | null }>('SELECT case_id FROM org.contracts WHERE id = $1', [id]));
      expect(row.rows[0].case_id).toBeNull();
    }
  });

  it('沒有物件的舊合約也能遷移：案件沒有 property_id 與租賃單位，標題用合約欄位快照', async () => {
    const id = await seedContract({ status: 'draft', fields: { propertyName: '快照名稱', propertyAddress: '快照地址' } });
    await migrateContractsToCases({ now: NOW });
    expect((await caseOf(id))?.record).toMatchObject({ propertyId: null, rentalUnitId: null, title: '快照名稱（快照地址）' });
  });
});
