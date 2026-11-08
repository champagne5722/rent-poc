// 分流條件的 repository（ADR-0021）。合約在 PostgreSQL（MIL-83），條件存在 fields.routing（jsonb）。

import { getContract } from '../contracts';
import type { ContractType } from '../labels';
import type { OrgTx } from '../pg/with-tx';
import { routingFactsOf } from './facts';
import type { RoutingFacts } from './types';

export type ContractRoutingLoad =
  | { ok: true; contractType: ContractType; facts: RoutingFacts }
  | { ok: false; code: 'not_found' | 'invalid_routing'; reason: string };

/** 讀合約的類型與分流條件，組成 `routeSignatures` 的輸入。別的組織的合約視為不存在。 */
export async function loadContractRoutingFacts(tx: OrgTx, contractId: string): Promise<ContractRoutingLoad> {
  const contract = await getContract(tx, contractId);
  if (!contract) return { ok: false, code: 'not_found', reason: '合約不存在' };

  const result = routingFactsOf(contract.contract_type, contract.fields.routing);
  if (!result.ok) return { ok: false, code: 'invalid_routing', reason: result.reason };
  return { ok: true, contractType: contract.contract_type, facts: result.facts };
}
