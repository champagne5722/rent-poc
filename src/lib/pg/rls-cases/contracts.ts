// 合約與合約子表。
import { newUlid } from '../ulid';
import type { CaseScopedRead, OrgTableCase, RlsRegistration } from './types';

const orgTables: Record<string, OrgTableCase> = {
  'org.contracts': {
    async seed(tx, orgId) {
      const id = newUlid();
      // legacy_id 固定：兩個組織寫同一組業務鍵 (org_id, legacy_id) 都要成功（陷阱 6）
      await tx.query('INSERT INTO org.contracts (id, org_id, legacy_id) VALUES ($1, $2, 1)', [id, orgId]);
      return id;
    },
  },
  'org.contract_events': {
    appendOnly: true,
    async seed(tx, orgId) {
      const contractId = newUlid();
      await tx.query('INSERT INTO org.contracts (id, org_id) VALUES ($1, $2)', [contractId, orgId]);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.contract_events (id, org_id, contract_id, type, actor, legacy_id) VALUES ($1, $2, $3, 'created', 'landlord', 1)`,
        [id, orgId, contractId],
      );
      return id;
    },
  },
  'org.contract_practitioner_assignments': {
    async seed(tx, orgId) {
      const contractId = newUlid();
      await tx.query('INSERT INTO org.contracts (id, org_id) VALUES ($1, $2)', [contractId, orgId]);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.contract_practitioner_assignments (id, org_id, contract_id, slot, entity_id, practitioner_id)
         VALUES ($1, $2, $3, 'penetration.slot', 'entity', 'practitioner')`,
        [id, orgId, contractId],
      );
      return id;
    },
  },
  'org.contract_mandate_items': {
    async seed(tx, orgId) {
      // 父列：合約。業務鍵 (org_id, contract_id, position) 的 contract_id 是新的 ULID，position 固定
      const contractId = newUlid();
      await tx.query('INSERT INTO org.contracts (id, org_id) VALUES ($1, $2)', [contractId, orgId]);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.contract_mandate_items (id, org_id, contract_id, position, property_id, property_name, property_address)
         VALUES ($1, $2, $3, 0, 'penetration-property', '滲透測試物件', '滲透測試地址')`,
        [id, orgId, contractId],
      );
      return id;
    },
  },
};

const caseScopedReads: Record<string, CaseScopedRead> = {
  'org.contracts': {
    readableBy: ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker', 'mandator', 'mandatary'],
    note: '包租案件的 owner 讀不到合約（P0-09 AC5）',
  },
  'org.contract_events': { readableBy: [], note: '合約歷程。成員讀取未開放，承租人端不需要（MIL-121）' },
  'org.contract_practitioner_assignments': { readableBy: [], note: '舊表只剩沒有案件的合約（MIL-200 起有案件的合約存成案件成員，MIL-203 移除舊表），只有主辦組織讀取' },
  'org.contract_mandate_items': { readableBy: [], note: '委託標的清單（MIL-74）。合約子表，沒有 case_id，只有主辦組織讀取' },
};

export const contractsRls: RlsRegistration = { orgTables, caseScopedReads };
