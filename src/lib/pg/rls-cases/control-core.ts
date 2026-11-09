// control schema 的帳號、組織、成員關係、session 與一次性驗證碼。這些表不屬於任何組織，不掛 RLS。
import type { ControlTableException, RlsRegistration } from './types';

const controlTables: Record<string, ControlTableException> = {
  'control.schema_migrations': {
    reason: 'migration runner 的版本紀錄，只有 app_owner 讀寫',
    appRw: [],
  },
  'control.orgs': {
    reason: '組織目錄，登入與 withTx 設定脈絡之前就要查。MIL-106 起可新增（第一次登入建組織），不能改或刪',
    appRw: ['SELECT', 'INSERT'],
  },
  'control.parties': {
    reason: '自然人，以 email 為唯一鍵，不屬於任何組織（承租人跨組織）。MIL-103',
    appRw: ['SELECT', 'INSERT'],
  },
  'control.users': {
    reason: '登入帳號，一個 party 一個帳號，帳號可屬多個組織。MIL-103',
    appRw: ['SELECT', 'INSERT'],
  },
  'control.org_memberships': {
    reason: '帳號與組織的成員關係，登入時要跨組織查，才能決定組織脈絡。MIL-103，成員管理由 MIL-106 接手',
    appRw: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  },
  'control.org_invitations': {
    reason: '以 email 邀請成員，被邀請者登入前沒有帳號也沒有組織脈絡，登入流程要依 email 跨組織查。查詢與寫入一律明確帶 org_id。MIL-106',
    appRw: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  },
  'control.sessions': {
    reason: '伺服器端 session，登入前沒有組織脈絡可用。只存 token 的雜湊。MIL-103',
    appRw: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  },
  'control.login_otps': {
    reason: '一次性驗證碼，登入前沒有組織脈絡可用。只存 HMAC 雜湊。MIL-103',
    appRw: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  },
};

export const controlCoreRls: RlsRegistration = { controlTables };
