import { commitTransition, getContract, type ContractEventInput } from './contracts';
import type { OrgTx } from './pg/with-tx';
import type { ProgressOutcome } from './signing-module/progress';
import type { CurrentSigner } from './signing-module/provider';
import { isSigningStatus, SIGNER_ROLE_LABELS, type ContractStatus, type SignerRole } from './types';

// 簽署結果 → 合約狀態轉移（ADR-0010 決議 7）。合約狀態是簽署進度的投影，
// 由當前簽署人的角色決定，順序改變時對照表不變。

// 簽署結果：簽署模組回報的推進結果，加上送簽成功。
export type ContractSigningResult = ProgressOutcome | { type: 'sent'; first: CurrentSigner };

export interface TransitionDecision {
  status: ContractStatus;
  event: ContractEventInput;
}

const STATUS_BY_ROLE: Record<SignerRole, ContractStatus> = {
  party_b: 'awaiting_tenant',
  party_a: 'awaiting_landlord',
  practitioner: 'awaiting_practitioner',
};

// 純函式 seam：由合約狀態與簽署結果決定「下一狀態」與「要記的歷程事件」。
// 回 null 表示合約不轉移也不寫歷程。沒有任何 I/O，可獨立測試（ADR-0007 要求兩者一致）。
export function decideTransition(status: ContractStatus, result: ContractSigningResult): TransitionDecision | null {
  if (result.type === 'sent') {
    if (status !== 'draft') return null;
    const { role, email } = result.first;
    return {
      status: STATUS_BY_ROLE[role],
      event: { type: 'sent', actor: 'landlord', note: `寄送給${SIGNER_ROLE_LABELS[role]} ${email}` },
    };
  }
  if (!isSigningStatus(status)) return null;

  switch (result.type) {
    case 'signer_signed':
      // 最後一位簽完不動狀態，等全員完成才完成
      if (!result.next) return null;
      return {
        status: STATUS_BY_ROLE[result.next.role],
        event: { type: 'signer_signed', actor: result.signer.role, note: null },
      };
    case 'completed':
      return { status: 'completed', event: { type: 'completed', actor: 'system', note: null } };
    case 'declined':
      return {
        status: 'declined',
        event: { type: 'declined', actor: result.signer?.role ?? 'system', note: result.reason ?? null },
      };
    case 'voided':
      return { status: 'voided', event: { type: 'voided', actor: 'landlord', note: null } };
  }
}

// 套用轉移：先鎖住合約再讀目前狀態，狀態與歷程事件在同一個交易寫入（任一失敗一起回滾）。
// 合約不存在（含別的組織的合約）或不接受這個結果時回 null，不寫任何東西。
export async function applySigningResult(
  tx: OrgTx,
  contractId: string,
  result: ContractSigningResult
): Promise<ContractStatus | null> {
  const contract = await getContract(tx, contractId, 'update');
  if (!contract) return null;
  const decision = decideTransition(contract.status, result);
  if (!decision) return null;

  await commitTransition(tx, contractId, {
    status: decision.status,
    event: decision.event,
    declinedReason: result.type === 'declined' ? (result.reason ?? null) : null,
  });
  return decision.status;
}
