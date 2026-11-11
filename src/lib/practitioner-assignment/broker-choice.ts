// 居間選項的可選狀態（MIL-200，ADR-0029 決議 3）。純函式，畫面與伺服端共用。
// 第一階段居間只支援主辦組織自己兼營經紀業：主辦組織有已驗證的經紀業別時，才得勾選居間，並指派自家的經紀人。
// 伺服端只看呼叫者自己組織的登錄（registry.my_registration），不接受前端傳入的旗標。

import type { OrgKind } from '../request-context';

/** 居間選項在畫面上的狀態。 */
export type BrokerChoice =
  | { kind: 'hidden' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'allowed' };

/** 經紀業別登錄了但還沒驗證時，畫面寫在居間選項旁邊的原因。 */
export const BROKERAGE_BLOCKED_REASON = '經紀業別驗證後才能勾選';

/** 伺服端擋下居間的回應訊息。屋主組織與沒有經紀業別的組織共用，不透露組織有沒有登錄。 */
export const BROKER_NOT_ALLOWED_MESSAGE = '這個組織不能勾選居間';
export const BROKER_NOT_ALLOWED_CODE = 'broker_not_allowed';

/** 組織自己的經紀業別登錄狀態。沒有登錄經紀業別是 null。 */
export type BrokerageState = 'verified' | 'registered' | null;

/**
 * - 屋主與平台組織：不顯示居間選項，也不提示。
 * - 執業主體組織：經紀業別已驗證可選。登錄了但還沒驗證，顯示成不能選並寫原因。沒有登錄經紀業別，不顯示。
 */
export function brokerChoiceOf(orgKind: OrgKind, brokerage: BrokerageState): BrokerChoice {
  if (orgKind !== 'practice') return { kind: 'hidden' };
  if (brokerage === 'verified') return { kind: 'allowed' };
  if (brokerage === 'registered') return { kind: 'blocked', reason: BROKERAGE_BLOCKED_REASON };
  return { kind: 'hidden' };
}
