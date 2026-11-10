import { TENANT_RELATIONS, type CaseState, type TenantRelation } from '../cases';
import type { CaseMemberTx } from '../case-store';
import type { PartyTx } from '../pg/with-tx';
import type { ContractStatus } from '../types';
import type { TenantCaseDetail, TenantCaseSummary } from './types';

// 承租人端的 SQL（MIL-121）。兩種交易：
// - 清單：party 脈絡（PartyTx），靠成員讀取政策（member_read、self_read）篩選，不需要組織。
// - 詳情與下載：CaseMemberTx，withCaseMemberTx 第 3 步之後的交易。第 3 步之後看得到整個組織的資料，
//   所以這裡每一個查詢都用 tx.caseId 過濾，不接受呼叫端傳別的案件（ADR-0016 決議 16）。

interface CaseRow {
  id: string;
  org_name: string;
  state: CaseState;
  business_type: TenantCaseSummary['businessType'];
  case_kind: TenantCaseSummary['caseKind'];
  title: string;
  lease_start: string | null;
  lease_end: string | null;
  monthly_rent: number | null;
  created_at: Date;
}

const CASE_COLUMNS = `k.id, o.name AS org_name, k.state, k.business_type, k.case_kind, k.title,
  to_char(k.lease_start, 'YYYY-MM-DD') AS lease_start, to_char(k.lease_end, 'YYYY-MM-DD') AS lease_end,
  k.monthly_rent, k.created_at`;

/**
 * 這個 party 在所有組織的承租案件，新的在前（P0-21 AC1）。
 * 只列自己是有效 lessee 或 co_lessee 的案件：出租人、屋主等關係不屬於承租人端。
 * 結案的案件仍列出，唯讀（P0-09 AC6）。
 */
export async function selectTenantCases(tx: PartyTx, partyId: string): Promise<TenantCaseSummary[]> {
  const { rows } = await tx.query<CaseRow & { contract_status: ContractStatus | null; relation: TenantRelation }>(
    `SELECT ${CASE_COLUMNS}, c.status AS contract_status,
            (SELECT m.relation FROM org.case_members m
              WHERE m.case_id = k.id AND m.party_id = $1 AND m.relation = ANY($2::text[]) AND m.valid_period @> now()
              ORDER BY m.relation LIMIT 1) AS relation
       FROM org.cases k
       JOIN control.orgs o ON o.id = k.org_id
       LEFT JOIN org.contracts c ON c.id = k.current_contract_id
      WHERE EXISTS (SELECT 1 FROM org.case_members m
                     WHERE m.case_id = k.id AND m.party_id = $1 AND m.relation = ANY($2::text[]) AND m.valid_period @> now())
      ORDER BY k.id DESC`,
    [partyId, [...TENANT_RELATIONS]],
  );
  return rows.map((r) => ({
    id: r.id,
    orgName: r.org_name,
    state: r.state,
    businessType: r.business_type,
    caseKind: r.case_kind,
    title: r.title,
    leaseStart: r.lease_start,
    leaseEnd: r.lease_end,
    monthlyRent: r.monthly_rent,
    contractStatus: r.contract_status,
    relation: r.relation,
    createdAt: r.created_at.toISOString(),
  }));
}

/** 目前合約的 ID 與狀態。案件沒有合約時是 null。 */
async function selectCurrentContract(tx: CaseMemberTx): Promise<{ id: string; status: ContractStatus } | null> {
  const { rows } = await tx.query<{ id: string; status: ContractStatus }>(
    `SELECT c.id, c.status FROM org.cases k JOIN org.contracts c ON c.id = k.current_contract_id AND c.case_id = k.id
      WHERE k.id = $1`,
    [tx.caseId],
  );
  return rows[0] ?? null;
}

export interface SignedPdfRecord {
  objectKey: string;
  sha256: string;
  fileName: string;
  contentType: string;
}

/** 目前合約已保存的簽署 PDF 紀錄。沒有（或保存失敗）是 null。 */
async function selectSignedPdf(tx: CaseMemberTx, contractId: string): Promise<SignedPdfRecord | null> {
  const { rows } = await tx.query<{ object_key: string; sha256: string; file_name: string; content_type: string | null }>(
    `SELECT f.object_key, f.sha256, f.file_name, f.content_type
       FROM org.sign_task_files f
       JOIN org.sign_tasks t ON t.id = f.sign_task_id AND t.org_id = f.org_id
       JOIN org.contracts c ON c.id = t.subject_id AND c.org_id = t.org_id
      WHERE t.subject_type = 'contract' AND t.subject_id = $1 AND c.case_id = $2
        AND f.kind = 'signed_pdf' AND f.status = 'saved' AND f.object_key IS NOT NULL AND f.sha256 IS NOT NULL
      ORDER BY f.saved_at DESC LIMIT 1`,
    [contractId, tx.caseId],
  );
  const r = rows[0];
  return r ? { objectKey: r.object_key, sha256: r.sha256, fileName: r.file_name, contentType: r.content_type ?? 'application/pdf' } : null;
}

/** 目前合約是否完成簽署，以及已簽 PDF 的紀錄。下載的第一步，在 withCaseMemberTx 內呼叫。 */
export async function findSignedPdf(
  tx: CaseMemberTx,
): Promise<{ kind: 'not_completed' } | { kind: 'none' } | { kind: 'file'; record: SignedPdfRecord }> {
  const contract = await selectCurrentContract(tx);
  if (!contract || contract.status !== 'completed') return { kind: 'not_completed' };
  const record = await selectSignedPdf(tx, contract.id);
  return record ? { kind: 'file', record } : { kind: 'none' };
}

/** 案件詳情。在 withCaseMemberTx 內呼叫。E 線的資料（押金、點交、報修）也加在這裡，一律用 tx.caseId 過濾。 */
export async function readTenantCaseDetail(tx: CaseMemberTx): Promise<TenantCaseDetail> {
  const { rows } = await tx.query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM org.cases k JOIN control.orgs o ON o.id = k.org_id WHERE k.id = $1`,
    [tx.caseId],
  );
  const row = rows[0];
  if (!row) throw new Error(`案件 ${tx.caseId} 在讀取詳情時消失了`);

  const lessors = await tx.query<{ display_name: string }>(
    `SELECT p.display_name FROM org.case_members m JOIN control.parties p ON p.id = m.party_id
      WHERE m.case_id = $1 AND m.relation = 'lessor' AND m.valid_period @> now() ORDER BY m.id`,
    [tx.caseId],
  );
  const contract = await selectCurrentContract(tx);
  const signed = contract?.status === 'completed' ? await selectSignedPdf(tx, contract.id) : null;
  const relation: TenantRelation = tx.relations.includes('lessee') ? 'lessee' : 'co_lessee';

  return {
    id: row.id,
    orgName: row.org_name,
    state: row.state,
    businessType: row.business_type,
    caseKind: row.case_kind,
    title: row.title,
    leaseStart: row.lease_start,
    leaseEnd: row.lease_end,
    monthlyRent: row.monthly_rent,
    relation,
    lessorNames: lessors.rows.map((r) => r.display_name),
    contract: contract ? { status: contract.status, hasSignedPdf: signed !== null } : null,
    createdAt: row.created_at.toISOString(),
  };
}
