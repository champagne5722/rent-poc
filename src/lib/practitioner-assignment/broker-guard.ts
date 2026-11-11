// 居間的伺服端檢查（MIL-200，ADR-0029 決議 3）。只看呼叫者自己組織的經紀業別登錄，不接受前端傳入的旗標。
// 登錄來自 registry.my_registration()，它只回目前組織自己的執業主體與業別，別的組織的資料讀不到。

import { getMyRegistration } from '../practice-entities/applicant';
import type { OrgTx } from '../pg/with-tx';
import type { OrgKind } from '../request-context';
import { brokerChoiceOf, type BrokerageState, type BrokerChoice } from './broker-choice';

/** 呼叫者自己組織的經紀業別登錄狀態。沒有登錄執業主體，或沒有登錄經紀業別都是 null。 */
export async function loadBrokerageState(tx: OrgTx): Promise<BrokerageState> {
  const registration = await getMyRegistration(tx);
  const license = registration?.licenses.find((l) => l.kind === 'brokerage');
  if (!license) return null;
  return license.state === 'verified' ? 'verified' : 'registered';
}

/** 居間選項的狀態。畫面用它決定顯示、不能選或可選，伺服端用它擋下 `brokerMediated: true`。 */
export async function loadBrokerChoice(tx: OrgTx, orgKind: OrgKind): Promise<BrokerChoice> {
  // 屋主與平台組織不必查登錄：它們沒有執業主體，也不顯示居間選項
  if (orgKind !== 'practice') return brokerChoiceOf(orgKind, null);
  return brokerChoiceOf(orgKind, await loadBrokerageState(tx));
}

/** 這個組織現在能不能把合約的分流條件設成有居間。 */
export async function canMediateBroker(tx: OrgTx, orgKind: OrgKind): Promise<boolean> {
  return (await loadBrokerChoice(tx, orgKind)).kind === 'allowed';
}
