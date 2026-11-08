import { getContract } from './contracts';
import { runInOrgTx } from './org-route';
import type { OrgTx } from './pg/with-tx';
import type { SigningSubject } from './signing-module/provider';
import { SigningRefusal, type SigningSubscriber } from './signing-module/subscriber';
import { applySigningResult } from './transitions';
import type { Contract } from './types';

// 合約層訂閱簽署事件：合約狀態是簽署進度的投影（ADR-0010 決議 7）。
// 轉移規則在 transitions.ts。文件保存與服務商任務編號都在簽署模組內，合約層不經手。
//
// 合約在 PostgreSQL（MIL-83）。每個方法開自己的組織交易，交易邊界在方法內：
// 簽署任務還在 SQLite，兩邊無法同一個交易（MIL-85 搬進 PostgreSQL 後合併）。
// `inOrg` 預設取目前請求的組織脈絡，測試傳入固定組織的交易。
// 過渡期的 webhook 沒有請求身分，org 脈絡是預設組織（DEFAULT_ORG_ID）。
export type InOrgTx = <R>(fn: (tx: OrgTx) => Promise<R>) => Promise<R>;

export function createContractSubscriber(inOrg: InOrgTx = runInOrgTx): SigningSubscriber {
  const contractOf = async (tx: OrgTx, subject: SigningSubject): Promise<Contract> => {
    const contract = await getContract(tx, subject.id);
    if (!contract) throw new SigningRefusal(404, '合約不存在');
    return contract;
  };

  return {
    label: '合約',
    exists: (subject) => inOrg(async (tx) => Boolean(await getContract(tx, subject.id))),
    currentStatus: (subject) => inOrg(async (tx) => (await contractOf(tx, subject)).status),
    isCompleted: (subject) => inOrg(async (tx) => (await contractOf(tx, subject)).status === 'completed'),

    onSent: (subject, { signers }) =>
      inOrg(async (tx) => {
        const { role, name, email } = signers[0];
        const next = await applySigningResult(tx, subject.id, { type: 'sent', first: { role, name, email } });
        if (!next) throw new SigningRefusal(409, '僅草稿可送簽');
      }),

    onOutcome: (subject, outcome) =>
      inOrg(async (tx) => {
        await contractOf(tx, subject); // 合約不存在時回 404，而不是靜默略過
        await applySigningResult(tx, subject.id, outcome);
      }),

    // 文件保存已由簽署模組負責，合約完成後沒有其他處理
    afterCompleted: async () => {},

    // 簽署中卻沒有任務編號的舊合約沒有回填簽署任務，仍要能撤回
    voidWithoutTask: (subject) =>
      inOrg(async (tx) => {
        if (!(await applySigningResult(tx, subject.id, { type: 'voided' }))) {
          throw new SigningRefusal(409, '僅簽署中的合約可撤回');
        }
      }),
  };
}
