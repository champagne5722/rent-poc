// 分流條件的 repository（ADR-0021）。介面一律回傳 Promise，A 線遷移到 PostgreSQL 時只換內部。

import type Database from 'better-sqlite3';
import { getDb } from '../db';
import type { ContractType } from '../labels';
import { routingFactsOf } from './facts';
import type { RoutingFacts } from './types';

export type ContractRoutingLoad =
  | { ok: true; contractType: ContractType; facts: RoutingFacts }
  | { ok: false; code: 'not_found' | 'invalid_routing'; reason: string };

/** 讀合約的類型與分流條件，組成 `routeSignatures` 的輸入。 */
export async function loadContractRoutingFacts(
  contractId: number,
  db: Database.Database = getDb(),
): Promise<ContractRoutingLoad> {
  const row = db.prepare('SELECT contract_type, fields FROM contracts WHERE id = ?').get(contractId) as
    | { contract_type: ContractType; fields: string }
    | undefined;
  if (!row) return { ok: false, code: 'not_found', reason: '合約不存在' };

  let stored: unknown;
  try {
    stored = (JSON.parse(row.fields) as { routing?: unknown }).routing;
  } catch {
    return { ok: false, code: 'invalid_routing', reason: '合約欄位不是合法的 JSON' };
  }

  const result = routingFactsOf(row.contract_type, stored);
  if (!result.ok) return { ok: false, code: 'invalid_routing', reason: result.reason };
  return { ok: true, contractType: row.contract_type, facts: result.facts };
}
