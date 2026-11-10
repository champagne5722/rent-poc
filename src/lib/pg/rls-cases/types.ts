import type { CaseMemberRelation } from '../../cases';
import type { OrgTx } from '../with-tx';

// 滲透測試登記的型別（ADR-0012 決議 6）。各模組檔從這裡取型別，不要反向 import `../rls-cases`，以免循環依賴。

export interface OrgTableCase {
  /**
   * 只增不改的表（同意紀錄、合約歷程）。app_rw 沒有 UPDATE 與 DELETE 權限，
   * 探測 2、3 改成預期「permission denied」，而不是 0 列。其餘探測不變。
   */
  appendOnly?: boolean;
  /**
   * 表有 BEFORE UPDATE 的 trigger（寫入後不得修改），它比 RLS 的 WITH CHECK 先執行。
   * 探測 3「自己的列改 org_id」的錯誤因此是這個訊息，不是 row-level security。
   * 別的組織看不到列，UPDATE 不會觸發 trigger，探測 2 仍是 0 列。
   */
  blockedUpdateMessage?: RegExp;
  /**
   * 在 tx 的脈絡內寫入一列，org_id 欄位用傳入的 orgId，回傳主鍵（欄位名一律是 id）。
   * 業務鍵必須固定，不得每次隨機：探測 5 靠兩個組織寫入同一組業務鍵，驗證唯一鍵含 org_id。
   * 需要父列（例如 registry 的租賃單位）時，在這裡一併建立。
   */
  seed(tx: OrgTx, orgId: string): Promise<string>;
}

/** 案件範圍表的成員讀取登記：哪些關係讀得到這張表，以及原因。 */
export interface CaseScopedRead {
  readableBy: readonly CaseMemberRelation[];
  note: string;
}

/** registry 表的登記：這張表放什麼。 */
export interface RegistryTableCase {
  purpose: string;
}

// ---------------------------------------------------------------------------
// 個資揭露矩陣（MIL-165）。規則全文在 `src/lib/practice-registry/README.md` 的「個資揭露矩陣」，
// 測試在 `src/lib/pg/registry-disclosure.test.ts`，呼叫者關係與測試資料在 `src/lib/pg/registry-disclosure-kit.ts`。

/** 矩陣檢查的個資欄位。 */
export type PiiField =
  /** 證號原文（序號未遮罩） */
  | 'certificateNo'
  /** 完整 email，不是遮罩後的 */
  | 'fullEmail'
  /** 統編 */
  | 'taxId'
  /** 核對紀錄 ID */
  | 'checkId'
  /** 失效或待驗證的任職（任職 ID，或已結束的任職期間） */
  | 'inactiveEmployment';

/**
 * 某種呼叫者關係呼叫函式的結果。陣列是「呼叫成功，而且回應含這些欄位」，空陣列代表成功但不含任何個資。
 * 'denied' 代表函式以 42501 拒絕。兩者不同：該拒絕卻回了空結果，或反過來，測試都會失敗。
 */
export type Exposure = readonly PiiField[] | 'denied';

/** 一種呼叫者關係一列。沒有列出的關係用 default。關係名稱見 registry-disclosure-kit.ts 的 CALLER_RELATIONS。 */
export interface ExposureTable {
  default: Exposure;
  by?: Readonly<Record<string, Exposure>>;
}

/** 測試資料裡，矩陣呼叫會用到的 ID。由 registry-disclosure-kit.ts 建立。 */
export interface DisclosureFixture {
  /** 北辰（有專任管理人員、待驗證與失效任職的執業主體） */
  entityId: string;
  /** 北辰成員的 party ID */
  partyIds: string[];
  /** 北辰專任管理人員的證書 ID */
  practitionerId: string;
  /** 任職 ID：active 是已驗證，pending 是待驗證，lapsed 是已結束 */
  employmentIds: { active: string; pending: string; lapsed: string };
  /** 證書鍵（種類:年:字:序號） */
  certificateKeys: { active: string; lapsed: string };
  /** 審核台項目：業別、證書（專任管理人員）、任職（已結束的那位） */
  reviewItems: { license: string; certificate: string; employment: string };
  /** 北辰與其他兩個執業主體的 ID */
  entityIds: string[];
}

/** 被探測對象的種類。設了就做「無關的組織逐值相同」檢查。 */
export type DisclosureSubject = 'entity' | 'employment' | 'certificateKey';

/** 一種呼叫方式。同一個函式有多種讀法時（列出、用 ID 查單筆）各寫一個。 */
export interface DisclosureVariant {
  label: string;
  /** 被探測對象。設了，測試另外確認「無關的組織探測真實對象」與「探測不存在的對象」回應逐值相同。 */
  subject?: DisclosureSubject;
  /** 在 tx 的脈絡內呼叫函式。subject 有設時，第三個參數是真實或不存在的對象。 */
  call(tx: OrgTx, fx: DisclosureFixture, subject: string): Promise<unknown>;
  expected: ExposureTable;
}

/**
 * 函式的個資揭露規則。每個 app_rw 能執行的 registry 函式必須有一個，不能靠漏登記通過。
 * - none：函式不回傳證號原文、完整 email、統編、核對紀錄 ID、失效任職。reason 寫為什麼。
 *   有 call 時，測試對每種關係都呼叫一次，確認真的沒有。沒有 call 的是寫入函式與其他沒有個資讀取路徑的函式。
 * - matrix：每種關係各有一列期望值，測試逐列驗證。
 * knownGaps：目前行為與原則不符，但已有票處理的關係。key 是關係名稱，值必須含票號。
 */
export type DisclosureRule =
  | { kind: 'none'; reason: string; call?: DisclosureVariant['call'] }
  | { kind: 'matrix'; reason: string; variants: readonly DisclosureVariant[]; knownGaps?: Readonly<Record<string, string>> };

/** 一個 registry 函式的跨組織探測。被探測的 ID 由測試提供：A 組織建好的物件，與隨機產生的不存在 ID。 */
export interface RegistryFunctionCase {
  /** 個資揭露規則（MIL-165）。 */
  disclosure: DisclosureRule;
  /**
   * 以 B 組織的脈絡呼叫函式，目標是 `target`（A 組織的物件，或不存在的隨機 ID）。
   * 回傳值或丟出的錯誤必須與目標的歸屬無關：兩種目標得到的結果必須逐位元相同。
   * 函式沒有接收別人能猜的 ID 時填 null，並在 reason 說明。
   */
  probe: ((tx: OrgTx, target: { anchorId: string; unitId: string }) => Promise<unknown>) | null;
  reason: string;
}


export interface ControlTableException {
  /** 為什麼這張表不掛組織 RLS，讀寫該怎麼走。 */
  reason: string;
  /** app_rw 允許的直接 DML。沒有列出的動作一律不得有權限，空陣列代表 app_rw 沒有任何權限。 */
  appRw: ReadonlyArray<'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'>;
}

/** audit schema 的表登記（MIL-89）。audit 的表歸 audit_owner，FORCE RLS，app_rw 只有登記的權限。 */
export interface AuditTable {
  /** 這張表放什麼，誰能讀寫。 */
  reason: string;
  /** app_rw 允許的直接權限。沒有列出的權限一律不得有，空陣列代表 app_rw 沒有任何權限，讀寫都經定義者函式。 */
  appRw: ReadonlyArray<'SELECT'>;
}

export interface DefinerOnlyTable {
  /** 這張表放什麼，經哪些函式存取。 */
  reason: string;
}

/**
 * 一個模組在滲透測試清單的登記。七個欄位都可省略，模組只填自己有的部分。
 * 各欄位的規則見 `../rls-cases.ts` 對應常數上方的說明。
 */
export interface RlsRegistration {
  /** 對應 `ORG_TABLE_CASES`。 */
  orgTables?: Record<string, OrgTableCase>;
  /** 對應 `CASE_SCOPED_READS`。 */
  caseScopedReads?: Record<string, CaseScopedRead>;
  /** 對應 `REGISTRY_TABLE_CASES`。 */
  registryTables?: Record<string, RegistryTableCase>;
  /** 對應 `REGISTRY_FUNCTION_CASES`。 */
  registryFunctions?: Record<string, RegistryFunctionCase>;
  /** 對應 `CONTROL_TABLE_EXCEPTIONS`。 */
  controlTables?: Record<string, ControlTableException>;
  /** 對應 `DEFINER_ONLY_TABLES`。 */
  definerOnlyTables?: Record<string, DefinerOnlyTable>;
  /** 對應 `AUDIT_TABLES`。 */
  auditTables?: Record<string, AuditTable>;
}
