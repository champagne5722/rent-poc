import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContract, getContract } from '../contracts';
import type { ContractType } from '../labels';
import { withTx } from '../pg/database';
import { setupRouteDb, TEST_PARTY_ID, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { ContractFields } from '../types';
import { attachContract } from './commands';
import { onContractOutcomeForCase, onContractSentForCase } from './contract-subscription';

// 案件對合約的訂閱（MIL-115）認得三種租賃類合約：租賃、包租、轉租（MIL-199）。
// 送簽時案件進入簽署中、同步租期與月租、承租人加為成員；全員完成時案件生效、建立押金台帳與應收期別。
// 連線是 PGlite 的 app_rw，RLS 生效。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);

const FIELDS = {
  landlordName: '甲出租的一方',
  landlordEmail: 'party-a@example.com',
  tenantName: '乙承租的一方',
  tenantEmail: 'party-b@example.com',
  propertyName: '信義小宅',
  propertyAddress: '台北市信義區松仁路 1 號',
  propertyType: '整層住家',
  propertySize: 20,
  rent: 30000,
  deposit: 60000,
  startDate: '2026-11-01',
  endDate: '2027-01-31',
  payDay: 5,
  extra: '',
};

// 案件種類對應舊欄位：包租案件是自管且承租人是包租業者，轉租案件是舊業務類型 master_lease（ADR-0030 決議 2）
const CASES: [ContractType, 'lease' | 'master_lease' | 'sublease', string][] = [
  ['lease', 'lease', 'self_managed'],
  ['master_lease', 'master_lease', 'self_managed'],
  ['sublease', 'sublease', 'master_lease'],
];

async function setup(type: ContractType, caseKind: string, businessType: string) {
  const caseId = newUlid();
  const contractId = await inA(async (tx) => {
    await tx.query(
      `INSERT INTO org.cases (id, org_id, kind, state, business_type, case_kind, title) VALUES ($1, $2, 'lease', 'draft', $3, $4, '測試案件')`,
      [caseId, kit.orgA, businessType, caseKind],
    );
    await tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'route-test@example.com', '測試帳號') ON CONFLICT DO NOTHING`, [TEST_PARTY_ID]);
    const id = await createContract(tx, { property_id: null, contract_type: type, fields: FIELDS as ContractFields, case_id: caseId });
    await attachContract(tx, caseId, id, { actor: { partyId: TEST_PARTY_ID } });
    return id;
  });
  return { caseId, contractId };
}

describe.each(CASES)('%s 合約的案件訂閱', (type, caseKind, businessType) => {
  it('送簽：案件進入簽署中，同步租期與月租，乙方加為承租成員', async () => {
    const { caseId, contractId } = await setup(type, caseKind, businessType);
    await inA(async (tx) => onContractSentForCase(tx, (await getContract(tx, contractId))!));
    const row = await inA((tx) =>
      tx.query<{ state: string; lease_start: string | null; monthly_rent: string | number | null }>(
        `SELECT state, lease_start::text AS lease_start, monthly_rent FROM org.cases WHERE id = $1`,
        [caseId],
      ),
    );
    expect(row.rows[0].state).toBe('signing');
    expect(String(row.rows[0].lease_start).slice(0, 10)).toBe('2026-11-01');
    expect(Number(row.rows[0].monthly_rent)).toBe(30000);
    const members = await inA((tx) =>
      tx.query<{ relation: string }>(`SELECT relation FROM org.case_members WHERE case_id = $1`, [caseId]),
    );
    expect(members.rows.map((m) => m.relation)).toContain('lessee');
  });

  it('全員完成：案件生效，建立押金台帳與三個應收期別', async () => {
    const { caseId, contractId } = await setup(type, caseKind, businessType);
    await inA(async (tx) => onContractSentForCase(tx, (await getContract(tx, contractId))!));
    await inA((tx) => onContractOutcomeForCase(tx, contractId, { type: 'completed' }));
    const state = await inA((tx) => tx.query<{ state: string }>(`SELECT state FROM org.cases WHERE id = $1`, [caseId]));
    expect(state.rows[0].state).toBe('active');
    const ledger = await inA((tx) =>
      tx.query<{ expected_amount: string | number }>(`SELECT expected_amount FROM org.deposit_ledgers WHERE case_id = $1`, [caseId]),
    );
    expect(ledger.rows).toHaveLength(1);
    expect(Number(ledger.rows[0].expected_amount)).toBe(60000);
    const periods = await inA((tx) => tx.query(`SELECT 1 FROM org.receivable_periods WHERE case_id = $1`, [caseId]));
    expect(periods.rows).toHaveLength(3);
  });
});
