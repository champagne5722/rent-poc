// 申請（委託管理申請、住宅包租申請）的動作（MIL-206，spec MIL-193，ADR-0029）。
// 申請跨業者與屋主兩個組織，沒有案件，所以都是組織層動作。
// 「這個組織是業者還是屋主」「這份申請是不是這個組織的」由資料庫函式檢查，動作表只看組織角色。
// 不是自己的申請與不存在的申請，函式都回同樣的結果，route 回同一個 404。
import { ALL_ROLES, WRITE_ROLES, type ActionRule } from './rules';

export const requestActions = {
  // 業者端：產生連結、代傳謄本。viewer 被拒
  'request.create': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
  'request.attach_file': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
  // 業者讀自己代傳的謄本原檔：個資敏感，只有 admin 與 staff，每次讀取寫稽核事件
  'request.read_file': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
  // 雙方讀自己的申請：所有角色
  'request.read': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
  // 屋主端：綁定連結、確認代填資料、送出、收回。viewer 被拒
  'request.claim': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
  'request.confirm_draft': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
  'request.submit': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
  'request.withdraw': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
} as const satisfies Record<string, ActionRule>;
