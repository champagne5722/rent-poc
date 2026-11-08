import {
  DEFAULT_OWNER_ORG_ID,
  PLATFORM_ORG_ID,
  PLATFORM_OPERATOR_EMAILS_ENV,
  SEED_OWNER_EMAIL_ENV,
} from './config';
import { normalizeEmail } from './email';
import type { OrgRole } from '../request-context';

// 環境變數指定的第一批帳號（ADR-0022 決議 4、Consequences）。
// - SEED_OWNER_EMAIL：A 線預設組織的 admin。既有資料掛在那個組織，這個帳號登入後看得到。
// - PLATFORM_OPERATOR_EMAILS：平台營運者，沒有自助註冊，由環境變數建立。
// 帳號在第一次通過驗證碼時才建立，成員資格在同一時間補上。

export interface BootstrapGrant {
  orgId: string;
  role: OrgRole;
}

function emailList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => normalizeEmail(item))
    .filter((item): item is string => item !== null);
}

export function bootstrapGrants(email: string, env: Readonly<Record<string, string | undefined>>): BootstrapGrant[] {
  const grants: BootstrapGrant[] = [];
  if (emailList(env[SEED_OWNER_EMAIL_ENV]).includes(email)) grants.push({ orgId: DEFAULT_OWNER_ORG_ID, role: 'admin' });
  if (emailList(env[PLATFORM_OPERATOR_EMAILS_ENV]).includes(email)) grants.push({ orgId: PLATFORM_ORG_ID, role: 'admin' });
  return grants;
}
