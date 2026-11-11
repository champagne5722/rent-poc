// 分流條件的 repository（ADR-0021）。合約在 PostgreSQL（MIL-83），條件存在 fields.routing（jsonb）。
//
// 案件種類取自案件（MIL-200，ADR-0030）：合約掛在案件下時，規則表要看的案件種類與業務類型讀案件列，
// 不再由合約的欄位快照推導。快照 `fields.routing` 不回寫：它仍是建約當時的紀錄，「是否有居間」也只存在快照裡。
// 沒有案件的合約（舊路徑，MIL-203 移除）仍由快照推導。

import { getContract } from '../contracts';
import type { ContractType } from '../labels';
import type { OrgTx } from '../pg/with-tx';
import { routingFactsOf } from './facts';
import type { RoutingFacts } from './types';

export type ContractRoutingLoad =
  | { ok: true; contractType: ContractType; facts: RoutingFacts }
  | { ok: false; code: 'not_found' | 'invalid_routing'; reason: string };

interface CaseBasisRow {
  case_kind: 'lease' | 'management' | 'master_lease' | 'sublease';
  business_type: 'self_managed' | 'managed' | 'master_lease' | null;
}

/** 租賃合約的分流事實，案件部分換成案件列的值。委託管理合約的案件種類固定，不換。 */
function withCaseBasis(facts: RoutingFacts, row: CaseBasisRow): RoutingFacts {
  if (facts.documentType !== 'lease') return facts;
  const { brokerMediated } = facts;
  if (row.case_kind === 'lease') {
    // 案件的業務類型只有自管與代管兩種會是租賃案件。其他值是資料不一致，不猜，沿用快照推導的結果
    if (row.business_type !== 'self_managed' && row.business_type !== 'managed') return facts;
    return { documentType: 'lease', brokerMediated, caseKind: 'lease', businessType: row.business_type };
  }
  if (row.case_kind === 'master_lease' || row.case_kind === 'sublease') {
    return { documentType: 'lease', brokerMediated, caseKind: row.case_kind };
  }
  return facts;
}

/** 讀合約的類型與分流條件，組成 `routeSignatures` 的輸入。別的組織的合約視為不存在。 */
export async function loadContractRoutingFacts(tx: OrgTx, contractId: string): Promise<ContractRoutingLoad> {
  const contract = await getContract(tx, contractId);
  if (!contract) return { ok: false, code: 'not_found', reason: '合約不存在' };

  const result = routingFactsOf(contract.contract_type, contract.fields.routing);
  if (!result.ok) return { ok: false, code: 'invalid_routing', reason: result.reason };

  const { rows } = await tx.query<CaseBasisRow>(
    `SELECT k.case_kind, k.business_type
       FROM org.contracts c JOIN org.cases k ON k.org_id = c.org_id AND k.id = c.case_id
      WHERE c.id = $1 AND c.org_id = current_setting('app.org_id', true)`,
    [contractId],
  );
  const facts = rows[0] ? withCaseBasis(result.facts, rows[0]) : result.facts;
  return { ok: true, contractType: contract.contract_type, facts };
}
