// 簽署任務、簽署人、簽署文件、簽章紀錄與簽署中失效紀錄。
import { newUlid } from '../ulid';
import type { OrgTx } from '../with-tx';
import type { CaseScopedRead, ControlTableException, OrgTableCase, RlsRegistration } from './types';

// 簽署任務。服務商任務編號固定：兩個組織各寫一列都要成功（陷阱 6）；
// 跨組織的唯一性由 control.sign_task_routes 保證，那張表在同檔的 controlTables。
async function seedSignTask(tx: OrgTx, orgId: string): Promise<string> {
  const id = newUlid();
  await tx.query(
    `INSERT INTO org.sign_tasks (id, org_id, provider, provider_task_ref, subject_type, subject_id)
     VALUES ($1, $2, 'mock', 'penetration-ref', 'contract', $3)`,
    [id, orgId, newUlid()],
  );
  return id;
}

const orgTables: Record<string, OrgTableCase> = {
  'org.sign_tasks': {
    async seed(tx, orgId) {
      return seedSignTask(tx, orgId);
    },
  },
  'org.signers': {
    async seed(tx, orgId) {
      const signTaskId = await seedSignTask(tx, orgId);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.signers (id, org_id, sign_task_id, position, role, name, email)
         VALUES ($1, $2, $3, 0, 'party_b', '滲透測試簽署人', 'penetration@example.com')`,
        [id, orgId, signTaskId],
      );
      return id;
    },
  },
  'org.sign_task_files': {
    async seed(tx, orgId) {
      const signTaskId = await seedSignTask(tx, orgId);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.sign_task_files (id, org_id, sign_task_id, kind, status, file_name)
         VALUES ($1, $2, $3, 'signed_pdf', 'failed', 'penetration.pdf')`,
        [id, orgId, signTaskId],
      );
      return id;
    },
  },
  'org.signature_records': {
    // 寫入後不得修改：BEFORE UPDATE 的 trigger 比 RLS 的 WITH CHECK 先執行，
    // 所以自己的列改 org_id 時，錯誤是 trigger 的訊息，不是 RLS 的
    blockedUpdateMessage: /簽章紀錄寫入後不得修改/,
    async seed(tx, orgId) {
      // 父列：合約、簽署任務、簽署人。業務鍵 (org_id, contract_id, rule_id) 的 contract_id 是新的 ULID，
      // rule_id 固定。兩個組織各寫一列都要成功（陷阱 6）
      const contractId = newUlid();
      await tx.query('INSERT INTO org.contracts (id, org_id) VALUES ($1, $2)', [contractId, orgId]);
      const signTaskId = newUlid();
      await tx.query(
        `INSERT INTO org.sign_tasks (id, org_id, provider, provider_task_ref, subject_type, subject_id)
         VALUES ($1, $2, 'mock', 'penetration-ref', 'contract', $3)`,
        [signTaskId, orgId, contractId],
      );
      const signerId = newUlid();
      await tx.query(
        `INSERT INTO org.signers (id, org_id, sign_task_id, position, role, name, email)
         VALUES ($1, $2, $3, 0, 'practitioner', '滲透測試執業人員', 'penetration@example.com')`,
        [signerId, orgId, signTaskId],
      );
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.signature_records
           (id, org_id, contract_id, signer_id, rule_id, statute_ref, rule_version, practitioner_id, employment_id,
            entity_id, license_kind, snapshot_at_send)
         VALUES ($1, $2, $3, $4, 'penetration.slot', 'x', 1, 'practitioner', 'employment', 'entity', 'master_lease', '{}'::jsonb)`,
        [id, orgId, contractId, signerId],
      );
      return id;
    },
  },
  'org.signing_lapses': {
    async seed(tx, orgId) {
      // 父列：合約、簽署任務、簽署人。業務鍵 (org_id, contract_id, rule_id) 的 contract_id 是新的 ULID，
      // rule_id 固定。兩個組織各寫一列都要成功（陷阱 6）
      const contractId = newUlid();
      await tx.query('INSERT INTO org.contracts (id, org_id) VALUES ($1, $2)', [contractId, orgId]);
      const signTaskId = newUlid();
      await tx.query(
        `INSERT INTO org.sign_tasks (id, org_id, provider, provider_task_ref, subject_type, subject_id)
         VALUES ($1, $2, 'mock', 'penetration-ref', 'contract', $3)`,
        [signTaskId, orgId, contractId],
      );
      const signerId = newUlid();
      await tx.query(
        `INSERT INTO org.signers (id, org_id, sign_task_id, position, role, name, email)
         VALUES ($1, $2, $3, 0, 'practitioner', '滲透測試執業人員', 'penetration@example.com')`,
        [signerId, orgId, signTaskId],
      );
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.signing_lapses (id, org_id, contract_id, signer_id, rule_id, state, event_at)
         VALUES ($1, $2, $3, $4, 'penetration.slot', 'void_pending', now())`,
        [id, orgId, contractId, signerId],
      );
      return id;
    },
  },
};

const caseScopedReads: Record<string, CaseScopedRead> = {
  'org.sign_tasks': { readableBy: ['lessor', 'mandator', 'mandatary'], note: '簽署任務，經合約對應到案件' },
  'org.signers': { readableBy: ['lessor', 'mandator', 'mandatary'], note: '經簽署任務對應到案件' },
  'org.sign_task_files': {
    readableBy: ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker', 'mandator', 'mandatary'],
    note: '只讀已簽 PDF（kind = signed_pdf），不含 Audit Trail File。經 簽署任務 → 合約 → 案件 對應，owner 讀不到（MIL-121，0049）',
  },
  'org.signature_records': { readableBy: [], note: '簽章紀錄只有主辦組織讀取' },
  'org.signing_lapses': { readableBy: [], note: '簽署中失效紀錄（MIL-75）。合約子表，沒有 case_id，只有主辦組織讀取' },
};

const controlTables: Record<string, ControlTableException> = {
  'control.sign_task_routes': {
    reason: 'webhook 沒有組織脈絡，靠它由服務商任務編號查出 org_id（ADR-0012 決議 5）。與簽署任務同交易寫入，寫入後不變',
    appRw: ['SELECT', 'INSERT'],
  },
};

export const signingRls: RlsRegistration = { orgTables, caseScopedReads, controlTables };
