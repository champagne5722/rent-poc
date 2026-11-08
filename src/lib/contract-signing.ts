import { getContract } from './contracts';
import type { OrgTx } from './pg/with-tx';
import type { SigningSubject } from './signing-module/provider';
import { SigningRefusal, type SigningSubscriber } from './signing-module/subscriber';
import { applySigningResult } from './transitions';
import type { Contract } from './types';

// 合約層訂閱簽署事件：合約狀態是簽署進度的投影（ADR-0010 決議 7）。
// 轉移規則在 transitions.ts。文件保存與服務商任務編號都在簽署模組內，合約層不經手。
//
// 每個方法用簽署模組給的 tx，與簽署進度同一個交易（MIL-85）。

export function createContractSubscriber(): SigningSubscriber {
  const contractOf = async (tx: OrgTx, subject: SigningSubject): Promise<Contract> => {
    const contract = await getContract(tx, subject.id);
    if (!contract) throw new SigningRefusal(404, '合約不存在');
    return contract;
  };

  return {
    label: '合約',
    exists: async (tx, subject) => Boolean(await getContract(tx, subject.id)),
    currentStatus: async (tx, subject) => (await contractOf(tx, subject)).status,
    isCompleted: async (tx, subject) => (await contractOf(tx, subject)).status === 'completed',

    beforeSend: async (tx, subject) => {
      if ((await contractOf(tx, subject)).status !== 'draft') throw new SigningRefusal(409, '僅草稿可送簽');
    },

    onSent: async (tx, subject, { signers }) => {
      const { role, name, email } = signers[0];
      const next = await applySigningResult(tx, subject.id, { type: 'sent', first: { role, name, email } });
      if (!next) throw new SigningRefusal(409, '僅草稿可送簽');
    },

    onOutcome: async (tx, subject, outcome) => {
      await contractOf(tx, subject); // 合約不存在時回 404，而不是靜默略過
      await applySigningResult(tx, subject.id, outcome);
    },

    // 簽署中卻沒有任務編號的舊合約沒有回填簽署任務，仍要能撤回
    voidWithoutTask: async (tx, subject) => {
      if (!(await applySigningResult(tx, subject.id, { type: 'voided' }))) {
        throw new SigningRefusal(409, '僅簽署中的合約可撤回');
      }
    },

    // 文件保存已由簽署模組負責，合約完成後沒有其他處理
    afterCompleted: async () => {},
  };
}
