import type { LeasingAuthoritySendFacts, TrustItem } from '../leasing-authority/preconditions';
import type { OwnershipStatus } from './status';

// 「物件通過核對後才能建立案件與送簽」的規則（MIL-205，ADR-0028 決議 5）。
// 純函式，沒有 I/O，前端與伺服器端都能匯入。節點的讀取在 repository.ts 的 `getOwnershipGate`，
// 建立案件與送簽都只經由它，不各自查節點。

/** 錯誤碼。route 回應的 `code` 欄位，畫面據此判斷。 */
export const PROPERTY_NOT_VERIFIED_CODE = 'property_not_verified' as const;

/** 固定的原因文字。ADR-0028 決議 1：文字不得因別的組織是否登錄過同一個物件而不同。 */
export const PROPERTY_NOT_VERIFIED_MESSAGE = '物件尚未通過平台的文件核對';

/** 節點目前送件的文件事實，給送簽前提的必要文件檢查用。 */
export interface OwnershipNodeDocuments {
  id: string;
  /** 節點有目前送件。 */
  hasSubmission: boolean;
  /** 目前送件有信託登記。 */
  trustRegistered: boolean;
  /** 信託登記的四項資料，各自有沒有填。 */
  trustItemsProvided: TrustItem[];
}

/** 這個組織對一個租賃單位的核對事實。 */
export interface OwnershipGate {
  /**
   * 節點的狀態，含已失效（lapsed）。有未失效的節點時取它，否則取最近一個已失效的。沒有節點是 null。
   * 對外的「核對狀態」用 `toPropertyVerificationStatus`，不要直接顯示這個值。
   */
  nodeStatus: OwnershipStatus | null;
  node: OwnershipNodeDocuments | null;
}

/** 有已驗證的節點。建立案件與送簽的唯一判定條件。 */
export function isVerified(gate: Pick<OwnershipGate, 'nodeStatus'>): boolean {
  return gate.nodeStatus === 'verified';
}

/** 建立案件：只有已驗證的節點能放行。 */
export function canCreateCase(gate: Pick<OwnershipGate, 'nodeStatus'>): boolean {
  return isVerified(gate);
}

/** 送簽：只有已驗證的節點能放行。待驗證、驗證失敗、已失效與沒有節點都擋下。 */
export function canSendContract(gate: Pick<OwnershipGate, 'nodeStatus'>): boolean {
  return isVerified(gate);
}

/**
 * 把核對事實轉成送簽前提要的權源事實（`checkSendPreconditions` 的 `leasingAuthority`）。
 * 節點是所有權（kind: ownership）。必要文件取自目前送件：有送件就視為謄本與取得時間已提供。
 * 沒有節點時 primaryAuthority 是 null，並設 propertyNotVerified，原因只列「物件尚未通過平台的文件核對」。
 * 有節點時由節點狀態的原因說明（待驗證、驗證失敗、已失效），不重複列物件原因。
 */
export function leasingAuthorityFactsOf(rentalUnitId: string, gate: OwnershipGate): LeasingAuthoritySendFacts {
  const base = { rentalUnitId, hasPendingSuspectedDuplicate: false };
  if (!gate.node || gate.nodeStatus === null) return { ...base, primaryAuthority: null, propertyNotVerified: true };
  return {
    ...base,
    propertyNotVerified: false,
    primaryAuthority: {
      id: gate.node.id,
      kind: 'ownership',
      status: gate.nodeStatus,
      providedDocuments: gate.node.hasSubmission ? ['registry_transcript', 'transcript_obtained_at'] : [],
      trust: gate.node.trustRegistered
        ? { registered: true, providedItems: gate.node.trustItemsProvided }
        : { registered: false },
    },
  };
}
