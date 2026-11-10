import type {
  ControlTableException,
  DefinerOnlyTable,
  OrgTableCase,
  RegistryFunctionCase,
  RegistryTableCase,
  CaseScopedRead,
  RlsRegistration,
} from './rls-cases/types';
import { casesRls } from './rls-cases/cases';
import { consentRls } from './rls-cases/consent';
import { contractsRls } from './rls-cases/contracts';
import { controlCoreRls } from './rls-cases/control-core';
import { inboxTimersRls } from './rls-cases/inbox-timers';
import { ledgerRls } from './rls-cases/ledger';
import { notificationsRls } from './rls-cases/notifications';
import { outboxRls } from './rls-cases/outbox';
import { ownershipRls } from './rls-cases/ownership';
import { paymentAccountsRls } from './rls-cases/payment-accounts';
import { practiceEntitiesRls } from './rls-cases/practice-entities';
import { practitionersRls } from './rls-cases/practitioners';
import { propertiesRls } from './rls-cases/properties';
import { receiptsRls } from './rls-cases/receipts';
import { registryCoreRls } from './rls-cases/registry-core';
import { signingRls } from './rls-cases/signing';
import { vaultCredentialsRls } from './rls-cases/vault-credentials';

export type {
  ControlTableException,
  DefinerOnlyTable,
  DisclosureFixture,
  DisclosureRule,
  DisclosureVariant,
  Exposure,
  ExposureTable,
  OrgTableCase,
  PiiField,
  RegistryFunctionCase,
} from './rls-cases/types';

// 滲透測試的案例清單（ADR-0012 決議 6，MIL-81 建骨架，MIL-89 擴充）。
//
// 規則：org schema 的每張表必須在 ORG_TABLE_CASES 登記一個案例。
// rls-penetration.test.ts 從系統目錄列出 org 的所有表，缺案例就讓測試失敗，
// 所以新增 org 表的人不能略過隔離測試。
//
// 一個案例只需要說明「怎麼在某個組織寫入一列」。測試對每張表自動跑通用探測：
//   1. 自己看得到、改得到、刪得到
//   2. 別的組織看不到、改不到、刪不到（UPDATE 與 DELETE 影響 0 列）
//   3. 在 A 的脈絡寫入 B 的 org_id，被 RLS 擋下
//   4. 沒有組織脈絡時 0 筆
//   5. 兩個組織用同一組業務鍵各寫一列，都成功（陷阱 6：唯一鍵必須含 org_id）
// 表專屬的探測（複合外鍵穿透、view 的 security_invoker、併發）由 MIL-89 在 extra 欄位補。
//
// 登記放在 `./rls-cases/<模組>.ts`，每個模組一個檔。這個檔只負責組合，不放登記內容。
// 新模組登記的步驟（MIL-164）：
//   1. 新增 `./rls-cases/<模組>.ts`，匯出 `export const <模組>Rls: RlsRegistration = { ... }`。
//      模組只填自己有的欄位：`orgTables`（org 表的滲透案例）、`caseScopedReads`（案件範圍表的成員讀取矩陣）、
//      `registryTables` 與 `registryFunctions`（registry 的表與函式）、`controlTables`（control 表的例外）、
//      `definerOnlyTables`（只經 SECURITY DEFINER 函式存取的 registry 與 vault 表）。
//      型別從 `./rls-cases/types` 取。模組專用的 seed 輔助函式放在自己的檔內。
//   2. 在下面加一行 import，再在 RLS_MODULES 加一行。兩處都依檔名字母順序排列，不要加在檔尾。
// 既有模組的登記改自己模組的檔，不用動這個檔。
// 同一個表名或函式名只能由一個模組登記。重複登記會在載入時丟出錯誤。

const RLS_MODULES: readonly RlsRegistration[] = [
  casesRls,
  consentRls,
  contractsRls,
  controlCoreRls,
  inboxTimersRls,
  ledgerRls,
  notificationsRls,
  outboxRls,
  ownershipRls,
  paymentAccountsRls,
  practiceEntitiesRls,
  practitionersRls,
  propertiesRls,
  receiptsRls,
  registryCoreRls,
  signingRls,
  vaultCredentialsRls,
];

/** 依 RLS_MODULES 的順序，合併每個模組在某個欄位的登記。同名登記丟出錯誤，不靜默覆蓋。 */
function compose<K extends keyof RlsRegistration>(part: K): NonNullable<RlsRegistration[K]> {
  const merged: Record<string, unknown> = {};
  for (const registration of RLS_MODULES) {
    for (const [name, entry] of Object.entries(registration[part] ?? {})) {
      if (name in merged) throw new Error(`${part} 重複登記：${name}`);
      merged[name] = entry;
    }
  }
  return merged as NonNullable<RlsRegistration[K]>;
}

export const ORG_TABLE_CASES: Record<string, OrgTableCase> = compose('orgTables');

/** 傳入系統目錄列出的 org 表名（schema.table），回傳沒有登記案例的表。 */
export function tablesWithoutCase(tables: readonly string[]): string[] {
  return tables.filter((t) => !(t in ORG_TABLE_CASES));
}

/**
 * 案件範圍表的成員讀取矩陣（ADR-0016 決議 15，MIL-115）。
 * 規則：凡是有 case_id 或經合約掛在案件下的 org 表，都要在這裡列出「哪些關係讀得到」。
 * 空陣列代表成員一律讀不到，只有主辦組織（org_isolation）讀得到。
 * case-rls.test.ts 逐表、逐關係驗證資料庫的政策與這份清單一致，並檢查每張有 case_id 欄位的表都在清單內。
 * E 線加案件範圍表（押金、點交、修繕、帳務）時，在自己模組檔的 `caseScopedReads` 加一列並補 migration 的政策。
 */
export const CASE_SCOPED_READS: Record<string, CaseScopedRead> = compose('caseScopedReads');

// ---------------------------------------------------------------------------
// registry 的表與函式（MIL-143 加）
//
// registry 不掛組織 RLS（ADR-0012 決議 8），隔離靠兩件事：
//   1. app_rw 對 registry 的表沒有任何直接權限，只能呼叫 SECURITY DEFINER 函式。
//   2. 函式只回呼叫者組織有物件指向的錨點與單位，別的組織的 ID 與不存在的 ID 得到完全相同的結果。
// rls-penetration.test.ts 從系統目錄列出 registry 所有表與 app_rw 能執行的函式，缺登記就失敗。

/** registry 的每張表都必須登記。測試對每張表驗證 app_rw 的 SELECT、INSERT、UPDATE、DELETE 都被拒。 */
export const REGISTRY_TABLE_CASES: Record<string, RegistryTableCase> = compose('registryTables');

/**
 * app_rw 能執行的每個 registry 函式都必須登記。
 * 每個案例另有 `disclosure`（MIL-165）：這個函式對各種呼叫者關係揭露哪些個資。規則在
 * `src/lib/practice-registry/README.md` 的「個資揭露矩陣」，測試在 `registry-disclosure.test.ts`。
 */
export const REGISTRY_FUNCTION_CASES: Record<string, RegistryFunctionCase> = compose('registryFunctions');

/** 傳入系統目錄列出的 registry 表名（schema.table），回傳沒有登記案例的表。 */
export function registryTablesWithoutCase(tables: readonly string[]): string[] {
  return tables.filter((t) => !(t in REGISTRY_TABLE_CASES));
}

/** 傳入系統目錄列出的 registry 函式名（schema.name），回傳沒有登記案例的函式。 */
export function registryFunctionsWithoutCase(functions: readonly string[]): string[] {
  return functions.filter((f) => !(f in REGISTRY_FUNCTION_CASES));
}

/**
 * 傳入系統目錄列出的 registry 函式名（schema.name），回傳沒有個資揭露規則的函式（MIL-165）。
 * 沒有案例的函式也算沒有規則。規則本身見 `src/lib/practice-registry/README.md` 的「個資揭露矩陣」。
 */
export function registryFunctionsWithoutDisclosure(functions: readonly string[]): string[] {
  return functions.filter((f) => REGISTRY_FUNCTION_CASES[f]?.disclosure === undefined);
}

// control schema 的表不掛組織 RLS，也不需要滲透案例（ADR-0012 決議 3）。
// 取而代之的是這份例外清單：每張 control 表必須登記「為什麼不掛 RLS」，並寫明 app_rw 的直接 DML 權限。
// 不在清單內的 control 表讓 rls-penetration.test.ts 失敗，權限與清單不符也會失敗。
// 這些表的資料不屬於任何一個組織（帳號、成員關係、session、webhook 收件匣），權限逐表授予，不靠 RLS。
// 之後新增 control 表的人（F 線的 control.handovers 等）在自己模組檔的 `controlTables` 加進來。
// MIL-89 會擴充成完整的系統目錄檢查，沿用這份清單。

export const CONTROL_TABLE_EXCEPTIONS: Record<string, ControlTableException> = compose('controlTables');

/** 傳入系統目錄列出的 control 表名（schema.table），回傳沒有登記的表。 */
export function controlTablesWithoutException(tables: readonly string[]): string[] {
  return tables.filter((t) => !(t in CONTROL_TABLE_EXCEPTIONS));
}

// registry 與 vault 的表不掛組織 RLS，也不給 app_rw 任何直接權限，只經 SECURITY DEFINER 函式存取（ADR-0012 決議 3、8，MIL-109）。
// 取而代之的是這份清單：每張 registry、vault 表必須登記「存放什麼、誰能經函式讀寫」。
// 不在清單內的表讓 rls-penetration.test.ts 失敗；app_rw 或 PUBLIC 有任何表權限也會失敗。
// 之後新增 registry 或 vault 表的人（B 線的段碼參照表、C 線的證書與任職表等）在自己模組檔的 `definerOnlyTables` 加進來。

export const DEFINER_ONLY_TABLES: Record<string, DefinerOnlyTable> = compose('definerOnlyTables');

/** 傳入系統目錄列出的 registry 與 vault 表名（schema.table），回傳沒有登記的表。 */
export function definerOnlyTablesWithoutEntry(tables: readonly string[]): string[] {
  return tables.filter((t) => !(t in DEFINER_ONLY_TABLES));
}
