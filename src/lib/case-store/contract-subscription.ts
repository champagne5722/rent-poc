import { openCaseLedger } from '../case-ledger/open';
import { getContract, getContractCaseId } from '../contracts';
import type { CaseInput } from '../cases';
import type { OrgTx } from '../pg/with-tx';
import type { ProgressOutcome } from '../signing-module/progress';
import type { Contract } from '../types';
import { addCaseMember } from './commands';
import { dispatch } from './dispatch';
import { findOrCreateParty, normalizePartyEmail, updateLeaseTerms } from './repository';

// 案件對合約的訂閱（ADR-0016 決議 11，MIL-115）：送簽、全員完成、拒簽、撤回。
// 由 contract-signing.ts 的合約訂閱者在自己的方法內呼叫，用簽署模組給的 tx，與合約轉移、簽署進度同一個交易。
//
// 規則：
// - 不開交易，不呼叫外部 API。
// - 案件拒絕某個事件時，合約的轉移照常提交，案件寫 input_rejected 事件（dispatch 負責）。法律事實優先。
// - state_version 衝突時丟 CaseVersionConflict，整個交易回滾，由 webhook 的 inbox 重試。
// - 合約沒有案件（遷移前、執業主體組織的合約、委託管理合約）時什麼都不做。

/** 合約送簽成功：案件 draft → signing，同步租期，承租人依乙方 email 找或建 party 並加為 lessee。 */
export async function onContractSentForCase(tx: OrgTx, contract: Contract, now: Date = new Date()): Promise<void> {
  const caseId = await getContractCaseId(tx, contract.id);
  if (caseId === null) return;

  await dispatch(tx, caseId, { type: 'contract_sent', contractId: contract.id }, { now });
  if (contract.contract_type !== 'lease') return;

  const { fields } = contract;
  await updateLeaseTerms(
    tx,
    caseId,
    {
      leaseStart: fields.startDate || null,
      leaseEnd: fields.endDate || null,
      monthlyRent: Number.isInteger(fields.rent) && (fields.rent as number) >= 0 ? (fields.rent as number) : null,
    },
    now,
  );

  // 乙方 email 格式不符時不建 party，也不擋送簽：合約已經送出，簽署以服務商寄的連結為準
  if (normalizePartyEmail(fields.tenantEmail) === null) return;
  const partyId = await findOrCreateParty(tx, fields.tenantEmail, fields.tenantName);
  await addCaseMember(tx, caseId, { partyId, relation: 'lessee' }, { now });
}

/** 簽署模組回報的結果 → 案件輸入。某位簽署人簽完（還有下一位）不影響案件，回 null。 */
export function caseInputForOutcome(contractId: string, outcome: ProgressOutcome): CaseInput | null {
  switch (outcome.type) {
    case 'completed':
      return { type: 'contract_completed', contractId };
    case 'declined':
      return { type: 'contract_declined', contractId, reason: outcome.reason ?? null };
    case 'voided':
      return { type: 'contract_voided', contractId };
    case 'signer_signed':
      return null;
  }
}

/** 合約轉移已套用後，把簽署結果交給案件。`at` 是簽署事件時間。 */
export async function onContractOutcomeForCase(
  tx: OrgTx,
  contractId: string,
  outcome: ProgressOutcome,
  at: Date = new Date(),
): Promise<void> {
  const input = caseInputForOutcome(contractId, outcome);
  if (input === null) return;
  const caseId = await getContractCaseId(tx, contractId);
  if (caseId === null) return;
  const result = await dispatch(tx, caseId, input, { now: at });
  // 全員完成：同一個交易建立押金台帳與全部應收期別（ADR-0050 決議 4，MIL-123）。
  // 案件拒絕這個事件（不是目前合約、案件不在 signing）時不建：台帳要掛在案件真正採用的那份合約上
  if (result.ok && input.type === 'contract_completed') await openLedgerForCompletedLease(tx, caseId, contractId);
}

/**
 * 租賃案件的合約全員完成，建立押金台帳與應收期別。委託管理案件沒有租金與押金，什麼都不做。
 * 合約欄位不足以切期別時，openCaseLedger 會跳過期別並在稽核事件記下，不丟錯，所以不會讓完成事件回滾。
 */
async function openLedgerForCompletedLease(tx: OrgTx, caseId: string, contractId: string): Promise<void> {
  const contract = await getContract(tx, contractId);
  if (!contract || contract.contract_type !== 'lease') return;
  const { fields } = contract;
  const opened = await openCaseLedger(tx, caseId, {
    deposit: fields.deposit,
    startDate: fields.startDate,
    endDate: fields.endDate,
    payDay: fields.payDay,
    rent: fields.rent,
  });
  // 期別沒有建立時，原因只留在伺服器 log（稽核事件只記有沒有跳過，不放合約欄位的內容）
  if (opened.opened && opened.periodsSkipped !== null) {
    console.warn(`[case-ledger] 案件 ${caseId} 的應收期別沒有建立：${opened.periodsSkipped}`);
  }
}
