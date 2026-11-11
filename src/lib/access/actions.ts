// 動作表彙總檔（ADR-0023 決議 6、7，PRD P0-09 權限表）。
// 純常數與型別，沒有 I/O。每列寫允許的組織角色、案件關係、案件狀態，以及是否為代操作。
//
// 動作登記在 `./actions/<模組>.ts`，每個模組一個檔。這個檔只負責組合，不放動作內容。
// 新模組登記動作的步驟（MIL-164）：
//   1. 新增 `./actions/<模組>.ts`，匯出 `export const <模組>Actions = { ... } as const satisfies Record<string, ActionRule>`。
//      型別與狀態、角色常數（ALL_STATES、OPERATING、OPEN、ALL_ROLES、WRITE_ROLES）從 `./actions/rules` 取。
//   2. 在下面加一行 import，再在 ACTIONS 加一行 `...<模組>Actions`。兩處都依檔名字母順序排列，不要加在檔尾。
//   3. 在 decide-access.test.ts 的預期表加對應列。
// 既有模組的動作改自己模組的檔，不用動這個檔。
// 動作 ID 必須在所有模組間唯一。展開物件時，同名的 ID 會靜默覆蓋前一個。

import { auditActions } from './actions/audit';
import { caseActions } from './actions/case';
import { contractActions } from './actions/contract';
import { handoverActions } from './actions/handover';
import { ledgerActions } from './actions/ledger';
import { moveOutActions } from './actions/move-out';
import { notificationActions } from './actions/notification';
import { orgMemberActions } from './actions/org-member';
import { paymentAccountActions } from './actions/payment-account';
import { practiceRegistryActions } from './actions/practice-registry';
import { practitionerActions } from './actions/practitioner';
import { propertyActions } from './actions/property';
import { repairActions } from './actions/repair';
import { requestActions } from './actions/request';
import type { ActionRule } from './actions/rules';

export { MANDATE_SCOPES, ORG_ROLES, TERMINAL_CASE_STATES } from './actions/rules';
export type {
  ActionRule,
  CaseActionRule,
  CaseVariant,
  MandateScope,
  OrgActionRule,
  OrgRole,
} from './actions/rules';

/**
 * 動作表。鍵是動作 ID，對照 PRD P0-09 的權限表：
 * 自管案件的出租人、代管案件的屋主、代管業者、包租業者、包租案件的所有權人、承租人。
 */
export const ACTIONS = {
  ...auditActions,
  ...caseActions,
  ...contractActions,
  ...handoverActions,
  ...ledgerActions,
  ...moveOutActions,
  ...notificationActions,
  ...orgMemberActions,
  ...paymentAccountActions,
  ...practiceRegistryActions,
  ...practitionerActions,
  ...propertyActions,
  ...repairActions,
  ...requestActions,
} as const satisfies Record<string, ActionRule>;

export type ActionId = keyof typeof ACTIONS;

export const ACTION_IDS = Object.keys(ACTIONS) as readonly ActionId[];

/**
 * 物件還沒歸屬案件時，這個動作改用哪個組織層動作判斷。
 * 組織層動作原樣回傳。案件動作有 `uncased` 欄位時回傳該欄位，其餘回 `null`，載入者必須拒絕。
 * 帳務、修繕、點交這類動作一定要有案件，不得因為沒有案件而放行。
 */
export function actionForUncasedObject(action: ActionId): ActionId | null {
  const rule: ActionRule = ACTIONS[action];
  if (rule.scope === 'org') return action;
  return rule.uncased ?? null;
}
