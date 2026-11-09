import type { BusinessType, CaseState } from '../cases';

// 承租人端的資料形狀（MIL-121）。只放承租人該看到的欄位：不含 email、其他成員、完整建號、登記名義人。

/** 承租人端認得的案件關係。 */
export type TenantRelation = 'lessee' | 'co_lessee';

/** 我的案件清單的一列。 */
export interface TenantCaseSummary {
  id: string;
  /** 主辦組織的名稱（出租人或代管業者所屬的組織）。 */
  orgName: string;
  state: CaseState;
  businessType: BusinessType | null;
  /** 物件名稱與地址的快照。 */
  title: string;
  leaseStart: string | null;
  leaseEnd: string | null;
  monthlyRent: number | null;
  /** 目前合約的狀態。沒有合約（後繼案件）是 null。 */
  contractStatus: string | null;
  /** 我在這個案件的關係。 */
  relation: TenantRelation;
  createdAt: string;
}

/** 案件詳情「合約」區塊。 */
export interface TenantContractView {
  status: string;
  /** 合約已完成簽署，且已簽 PDF 已保存，可以下載。 */
  hasSignedPdf: boolean;
}

/** 案件詳情。E 線在這裡加押金、點交、報修的資料（見 README「給 E 線」）。 */
export interface TenantCaseDetail {
  id: string;
  orgName: string;
  state: CaseState;
  businessType: BusinessType | null;
  title: string;
  leaseStart: string | null;
  leaseEnd: string | null;
  monthlyRent: number | null;
  relation: TenantRelation;
  /** 出租人的名稱（案件的 lessor 成員）。包租案件是包租業者。 */
  lessorNames: string[];
  /** 沒有合約（後繼案件）是 null。 */
  contract: TenantContractView | null;
  createdAt: string;
}

export type SignedPdfResult =
  | { ok: true; bytes: Uint8Array; fileName: string; contentType: string }
  /** 目前合約還沒完成簽署。 */
  | { ok: false; reason: 'not_completed' }
  /** 沒有保存成功的檔案，或檔案不在 FileStore、內容與紀錄的 SHA-256 不符。 */
  | { ok: false; reason: 'not_available' };
