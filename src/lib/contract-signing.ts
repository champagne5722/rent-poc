import { getContract } from './db';
import type { SigningSubject } from './signing-module/provider';
import { SigningRefusal, type SigningSubscriber } from './signing-module/subscriber';
import { applySigningResult } from './transitions';
import type { Contract } from './types';

// 合約層訂閱簽署事件：合約狀態是簽署進度的投影（ADR-0010 決議 7）。
// 轉移規則在 transitions.ts。服務商任務編號仍雙寫到合約的欄位，留給文件保存那張票讀取。
export function createContractSubscriber(deps: {
  // 全員完成後保存文件。文件保存移進模組前的掛點。
  onCompleted: (contract: Contract) => Promise<void>;
}): SigningSubscriber {
  const contractOf = (subject: SigningSubject): Contract => {
    const contract = getContract(subject.id);
    if (!contract) throw new SigningRefusal(404, '合約不存在');
    return contract;
  };

  return {
    label: '合約',
    exists: (subject) => Boolean(getContract(subject.id)),
    currentStatus: (subject) => contractOf(subject).status,

    onSent(subject, { taskRef, signers }) {
      const { role, name, email } = signers[0];
      const next = applySigningResult(
        contractOf(subject),
        { type: 'sent', first: { role, name, email } },
        { dottedsignTaskId: taskRef }
      );
      if (!next) throw new SigningRefusal(409, '僅草稿可送簽');
    },

    onOutcome(subject, outcome) {
      applySigningResult(contractOf(subject), outcome);
    },

    afterCompleted: (subject) => deps.onCompleted(contractOf(subject)),

    // 簽署中卻沒有任務編號的舊合約沒有回填簽署任務，仍要能撤回
    voidWithoutTask(subject) {
      if (!applySigningResult(contractOf(subject), { type: 'voided' })) {
        throw new SigningRefusal(409, '僅簽署中的合約可撤回');
      }
    },
  };
}
