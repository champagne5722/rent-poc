// 合約類型定義的介面（MIL-73、ADR-0021 決議 2）。
// 欄位、範本與檢核由合約類型決定，共用流程（建約 wizard、送簽、清單）只經這個介面取用，
// 不直接判斷「是租賃合約還是委託管理合約」。只有純資料與純函式，沒有 fs，client 端也能引用。

import type { ContractType, PartyLabels } from '../labels';
import type { MandateItem } from '../mandate-schedule';
import type {
  ContractFields,
  ContractPartyRole,
  ContractRoutingConditions,
  ContractTemplate,
  LeaseContractFields,
  ManagementContractFields,
  OptionalClause,
  Property,
} from '../types';

/** 一位當事人的姓名與 email。 */
export interface PartyIdentity {
  name: string;
  email: string;
}

/** 取當事人只需要的欄位。傳入完整的合約欄位或這幾個欄位都可以。 */
export type LeasePartyFields = Pick<LeaseContractFields, 'landlordName' | 'landlordEmail' | 'tenantName' | 'tenantEmail'>;
export type ManagementPartyFields = Pick<
  ManagementContractFields,
  'mandatorName' | 'mandatorEmail' | 'mandataryName' | 'mandataryEmail'
>;
export type PartyFields = LeasePartyFields | ManagementPartyFields;

/** 合約清單一列需要的摘要。沒有單一物件或租期的合約類型回 null。 */
export interface ContractListSummary {
  propertyName: string | null;
  /** 月租金。沒有租金的合約類型（委託管理合約）為 null。 */
  rent: number | null;
  /** 乙方：租賃合約是承租人，委託管理合約是受託人。欄名依類型從標籤對照表取。 */
  partyB: PartyIdentity;
  /** 租期或委託期間的起迄（YYYY-MM-DD）。起迄沒填完或沒有期間時為 null。 */
  period: readonly [string, string] | null;
}

/**
 * 欄位以外、另存於子表的合約內容。委託管理合約的委託標的清單存在 contract_mandate_items（MIL-74），
 * 檢核必填時要一起看。沒有帶（undefined）代表呼叫端沒有載入，這一項就不檢查。
 */
export interface ContractAttachments {
  mandateItems?: readonly MandateItem[];
}

export interface InitialFieldsInput {
  /** 租賃合約從物件建立草稿，必須帶。委託管理合約的租賃單位在委託標的清單，不帶。 */
  property?: Property;
  routing?: ContractRoutingConditions;
}

/**
 * 一種合約類型的定義。`F` 是這個類型的欄位形狀。
 * 用方法簽名（不是函式屬性）宣告，登錄表才能把各類型的定義放進同一個型別。
 */
export interface ContractTypeDefinition<F extends ContractFields = ContractFields> {
  readonly type: ContractType;
  /** 文件名稱，用在送簽的檔名前綴，例如「租賃合約」。 */
  readonly documentName: string;
  /** 甲乙方稱謂，從標籤對照表（src/lib/labels）取。 */
  readonly labels: PartyLabels;
  /** 這個類型的範本與選用條款庫，版本與審閱旗標見 template-registry。 */
  readonly templates: readonly ContractTemplate[];
  readonly optionalClauses: readonly OptionalClause[];
  /** 甲方或乙方在欄位裡對應的姓名與 email。 */
  party(fields: F, role: ContractPartyRole): PartyIdentity;
  /** 把當事人寫進欄位，回傳新物件。選定當事人簽署人時用。 */
  withParty(fields: F, role: ContractPartyRole, person: PartyIdentity): F;
  /** 當事人姓名與 email 欄位的標籤。執業主體是這一方時，這兩個欄位由簽署人帶入。 */
  partyFieldLabels(role: ContractPartyRole): readonly [string, string];
  /** 建約 wizard 第②步的必填欄位檢核，回傳缺漏欄位的標籤。 */
  missingFields(fields: F, attachments?: ContractAttachments): string[];
  /** 送簽前伺服器端的必填欄位檢核，回傳缺漏欄位的標籤。 */
  missingFieldsForSend(fields: F, attachments?: ContractAttachments): string[];
  /**
   * 這個類型能不能送簽。委託管理合約的送簽屬 MIL-77，在那之前只做到草稿與 PDF 預覽。
   * 送簽 route 與 wizard 第④步都看它，不判斷具體類型。
   */
  readonly sendSupported: boolean;
  /** 建立草稿時要不要選物件。租賃合約從物件建立，委託管理合約的租賃單位在委託標的清單。 */
  readonly requiresProperty: boolean;
  /** 不需要選物件的類型，在建約入口與第①步顯示的說明。 */
  readonly draftNotice?: { title: string; description: string };
  /** 建立草稿時的欄位快照。 */
  initialFields(input: InitialFieldsInput): F;
  listSummary(fields: F): ContractListSummary;
}
