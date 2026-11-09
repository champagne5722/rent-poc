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

/** 一個 registry 函式的跨組織探測。被探測的 ID 由測試提供：A 組織建好的物件，與隨機產生的不存在 ID。 */
export interface RegistryFunctionCase {
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

export interface DefinerOnlyTable {
  /** 這張表放什麼，經哪些函式存取。 */
  reason: string;
}

/**
 * 一個模組在滲透測試清單的登記。六個欄位都可省略，模組只填自己有的部分。
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
}
