// 案件（org.cases、case_members、case_events）。
import { newUlid } from '../ulid';
import type { OrgTx } from '../with-tx';
import type { CaseScopedRead, OrgTableCase, RlsRegistration } from './types';

async function seedCase(tx: OrgTx, orgId: string): Promise<string> {
  const id = newUlid();
  await tx.query(
    `INSERT INTO org.cases (id, org_id, kind, state, business_type, title)
     VALUES ($1, $2, 'lease', 'draft', 'self_managed', '滲透測試案件')`,
    [id, orgId],
  );
  return id;
}

const orgTables: Record<string, OrgTableCase> = {
  'org.cases': {
    async seed(tx, orgId) {
      return seedCase(tx, orgId);
    },
  },
  'org.case_members': {
    async seed(tx, orgId) {
      const caseId = await seedCase(tx, orgId);
      // 全域的 party 固定一個：兩個組織各寫一列都要成功（陷阱 6），control.parties 不屬於任何組織
      await tx.query(
        `INSERT INTO control.parties (id, email, display_name)
         VALUES ('0000000000000000000000PEN1', 'penetration-member@example.com', '滲透測試成員')
         ON CONFLICT DO NOTHING`,
      );
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.case_members (id, org_id, case_id, party_id, relation)
         VALUES ($1, $2, $3, '0000000000000000000000PEN1', 'lessor')`,
        [id, orgId, caseId],
      );
      return id;
    },
  },
  'org.case_events': {
    // 寫入後不得修改也不得刪除：trigger 比 RLS 的 WITH CHECK 先執行（同 org.signature_records）
    blockedUpdateMessage: /案件事件寫入後不得修改或刪除/,
    async seed(tx, orgId) {
      const caseId = await seedCase(tx, orgId);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.case_events (id, org_id, case_id, type, occurred_at) VALUES ($1, $2, $3, 'created', now())`,
        [id, orgId, caseId],
      );
      return id;
    },
  },
};

const caseScopedReads: Record<string, CaseScopedRead> = {
  'org.cases': {
    readableBy: ['lessor', 'lessee', 'co_lessee', 'mandator', 'mandatary', 'owner', 'practitioner', 'broker'],
    note: '含租期欄位，所以包租案件的 owner 只讀這一張（P0-09 AC5）',
  },
  'org.case_members': {
    readableBy: ['lessor', 'mandator', 'mandatary'],
    note: '其他關係只讀自己的列（self_read，ADR-0012 決議 7）',
  },
  'org.case_events': { readableBy: ['lessor', 'mandator', 'mandatary'], note: '' },
};

export const casesRls: RlsRegistration = { orgTables, caseScopedReads };
