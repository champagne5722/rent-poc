import { contractTypeDefinition } from '../contract-types';
import type { LeasingAuthoritySendFacts } from '../leasing-authority/preconditions';
import type { OrgTx } from '../pg/with-tx';
import type { Contract } from '../types';
import { leasingAuthorityFactsOf } from './gate';
import { getOwnershipGate } from './repository';

// 送簽前提的權源事實（MIL-205，ADR-0028 決議 5）。送簽與送簽預覽（/practitioners）共用，原因因此一致。

/**
 * 讀合約的物件，查這個組織對它有沒有已驗證的所有權節點，組成 `checkSendPreconditions` 的 `leasingAuthority`。
 * 合約類型不綁物件（委託管理合約）時回 undefined，不檢查。
 * 合約類型要求物件，但合約沒有物件時，視為沒有通過核對（fail closed），不放行。
 * 一律由伺服器端的合約與物件決定，呼叫端不能傳入結果。
 */
export async function loadLeasingAuthorityFacts(
  tx: OrgTx,
  contract: Pick<Contract, 'contract_type' | 'property_id'>,
): Promise<LeasingAuthoritySendFacts | undefined> {
  if (!contractTypeDefinition(contract.contract_type).requiresProperty) return undefined;
  const rentalUnitId = contract.property_id ? await rentalUnitOf(tx, contract.property_id) : null;
  const gate = rentalUnitId ? await getOwnershipGate(tx, rentalUnitId) : { nodeStatus: null, node: null };
  return leasingAuthorityFactsOf(rentalUnitId ?? '', gate);
}

async function rentalUnitOf(tx: OrgTx, propertyId: string): Promise<string | null> {
  const { rows } = await tx.query<{ rental_unit_id: string }>('SELECT rental_unit_id FROM org.properties WHERE id = $1', [propertyId]);
  return rows[0]?.rental_unit_id ?? null;
}
