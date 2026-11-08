// 領域型別與詞彙，術語定義見 repo 根目錄 GLOSSARY.md

import type { BusinessType } from './cases';
import { TERMS } from './labels';

export const PROPERTY_TYPES = ['整層住家', '套房', '雅房'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

// 設備詞彙庫的平台預設項目（ADR-0008）：ensureSchema 開檔時 seed 進 equipment_vocabulary，
// 房東自訂項目與這些項目同一份字典，之後一律從資料庫讀，不再直接引用這個常數當選項。
export const EQUIPMENT_OPTIONS = [
  '冷氣',
  '洗衣機',
  '冰箱',
  '熱水器',
  '床',
  '衣櫃',
  '書桌',
  '網路',
  '第四台',
  '瓦斯爐',
] as const;

// 設備詞彙庫的一筆項目：房東層的設備字典，平台預設與自訂項目差在 is_custom
export interface EquipmentVocabularyItem {
  id: number;
  name: string;
  is_custom: 0 | 1;
  created_at: string;
}

// 設備清單的一列：詞彙庫項目＋數量（quantity 為 >= 1 的整數）。
// 修繕責任與備註屬合約層的設備附件，不在物件這裡（GLOSSARY.md）。
export interface EquipmentItem {
  name: string;
  quantity: number;
}

// 修繕責任（GLOSSARY.md）：設備附件每列的修繕歸屬，預設出租人（呼應內政部範本第八條精神）。
// 只存在合約層，物件的設備清單不記責任。
export const REPAIR_RESPONSIBILITIES = ['landlord', 'tenant'] as const;
export type RepairResponsibility = (typeof REPAIR_RESPONSIBILITIES)[number];

export const REPAIR_RESPONSIBILITY_LABELS: Record<RepairResponsibility, string> = {
  landlord: TERMS.lessor,
  tenant: TERMS.lessee,
};

// 設備附件的一列（ADR-0008）：項目＋數量＋修繕責任＋備註。
// 同名可以有多列（例如同型號冷氣兩台分屬不同修繕責任），故不做名稱唯一性限制。
export interface EquipmentAnnexRow {
  name: string;
  quantity: number;
  repair: RepairResponsibility;
  note: string;
}

export interface Property {
  id: number;
  name: string;
  address: string;
  type: PropertyType;
  size: number | null;
  default_rent: number | null;
  note: string;
  equipment: EquipmentItem[];
  created_at: string;
  updated_at: string | null;
}

export const CONTRACT_STATUSES = [
  'draft',
  'awaiting_tenant',
  'awaiting_practitioner',
  'awaiting_landlord',
  'completed',
  'declined',
  'voided',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

// 簽署中：合約狀態由當前簽署人的角色投影（ADR-0010），三種待簽狀態都算。
// 各畫面判斷簽署中一律用 isSigningStatus，不自行列舉狀態。
export const SIGNING_STATUSES = ['awaiting_tenant', 'awaiting_practitioner', 'awaiting_landlord'] as const;
export type SigningStatus = (typeof SIGNING_STATUSES)[number];

export function isSigningStatus(status: ContractStatus): status is SigningStatus {
  return (SIGNING_STATUSES as readonly ContractStatus[]).includes(status);
}

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: '草稿',
  awaiting_tenant: '待乙方簽',
  awaiting_landlord: '待甲方簽',
  awaiting_practitioner: '待執業人員簽',
  completed: '已完成',
  declined: '已拒簽',
  voided: '已撤回',
};

// 範本（Template）：平台提供、版面與條款寫死的租約底稿，版本化（ADR-0005）。
// PoC 只有一份，內容是平台資料而非使用者資料，維護介面屬 Admin 後台（範圍外）。
export interface ContractTemplate {
  id: string;
  name: string;
  version: number;
  provider: string;
  note: string;
  // 法務審閱旗標（P0-10 AC5）：標記這個版本的條文是否經法務審閱。範本維護者審閱後才改成 true。
  // 正式金鑰下，綁到未審閱範本的合約不得送簽（src/lib/template-review.ts）。
  legalReviewed: boolean;
}

// 選用條款（Optional Clause）：平台提供、經法務審閱的可勾選附加條款，逐約勾選後併入合約產出。
export interface OptionalClause {
  id: string;
  title: string;
  body: string;
  version: number;
}

/**
 * 合約裡的條款快照：形狀與 OptionalClause 相同，但值屬於合約自己的資料。
 * 建約時整段複製過來，之後平台條款改版不回溯影響（ADR-0005）。
 */
export type ClauseSnapshot = OptionalClause;

/**
 * 合約對範本的綁定與條款快照。收在 ContractFields 的 JSON 裡，不另開資料表欄位。
 * 三個欄位都可選：MIL-26 之前建立的合約沒有這些值，一律當成「未綁定版本、沒勾條款」。
 */
export interface TemplateBinding {
  templateId?: string;
  templateVersion?: number;
  clauses?: ClauseSnapshot[];
}

/**
 * 合約的設備附件快照（ADR-0008）。兩個欄位都可選，比照 TemplateBinding 的處理慣例：
 * - equipmentAnnex：MIL-29 起的正式形狀，建約由物件設備清單帶入、逐約調整後隨合約凍結。
 * - equipment：MIL-29 之前壓平成「名稱 ×數量」字串的舊形狀，只讀不寫。
 *
 * 一律用 equipment.ts 的 contractEquipmentAnnex() 讀，該函式會把舊形狀轉成附件列
 * （數量從字串解析回來、修繕責任出租方、備註空）。
 */
export interface EquipmentAnnexSnapshot {
  equipmentAnnex?: EquipmentAnnexRow[];
  /** @deprecated 舊合約相容用，新程式一律寫 equipmentAnnex */
  equipment?: string[];
}

/**
 * 分流條件（ADR-0021 決議 1）：收在 `fields.routing`，由建約 wizard 第一步填寫並隨草稿保存。
 * 選填：沒有這個鍵的合約視為自管租賃合約。C 線建案件後改由案件提供，既有合約維持這份快照。
 * 形狀與讀取規則見 src/lib/signature-routing/README.md。
 */
export interface ContractRoutingConditions {
  businessType: BusinessType;
  lesseeIsMasterLessor: boolean;
  brokerMediated: boolean;
}

// 合約欄位依合約類型（`contract_type`）分成兩種形狀，共用部分放在 ContractFieldsBase（MIL-73）。
// 欄位形狀由 `Contract` 的 `contract_type` 判別，欄位物件本身不帶類型，既有合約（沒有類型欄位前建立）
// 一律讀成租賃合約。依類型取值、檢核與建立草稿都經 src/lib/contract-types，共用流程不直接讀具體欄位。

/** 各合約類型共用的欄位：分流條件、範本綁定與條款快照、其他約定事項。 */
export interface ContractFieldsBase extends TemplateBinding {
  routing?: ContractRoutingConditions;
  extra: string; // 其他約定事項
}

// 租賃合約欄位值：建立時由物件帶入快照，之後與物件脫鉤（見 docs/domain-model.md）
export interface LeaseContractFields extends ContractFieldsBase, EquipmentAnnexSnapshot {
  landlordName: string;
  landlordEmail: string;
  tenantName: string;
  tenantEmail: string;
  propertyName: string;
  propertyAddress: string;
  propertyType: string;
  propertySize: number | null;
  rent: number | null;
  deposit: number | null; // 押金（元）
  startDate: string; // YYYY-MM-DD
  endDate: string;
  payDay: number | null; // 每月付款日
}

/**
 * 委託管理合約欄位值。目前只有共用基底與兩方當事人的姓名與 email，
 * 讓共用送簽流程能取得簽署人。委託標的清單、委託範圍、期間與報酬由 MIL-74 加入。
 */
export interface ManagementContractFields extends ContractFieldsBase {
  mandatorName: string; // 委託人（甲方）
  mandatorEmail: string;
  mandataryName: string; // 受託人（乙方）
  mandataryEmail: string;
}

/** 合約欄位：以合約的 `contract_type` 判別（見 `Contract`）。 */
export type ContractFields = LeaseContractFields | ManagementContractFields;

// 簽署角色（ADR-0010）：簽署人在文件上的地位。畫面文字一律從 SIGNER_ROLE_LABELS 取。
export const SIGNER_ROLES = ['party_a', 'party_b', 'practitioner'] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];

export const SIGNER_ROLE_LABELS: Record<SignerRole, string> = {
  party_a: '甲方',
  party_b: '乙方',
  practitioner: '執業人員',
};

// 合約當事人的簽署角色。簽署區編輯器與範本簽署欄只有這兩種，執業人員的簽署欄屬 P0-12。
export const CONTRACT_PARTY_ROLES = ['party_a', 'party_b'] as const satisfies readonly SignerRole[];
export type ContractPartyRole = (typeof CONTRACT_PARTY_ROLES)[number];

// 簽署區域：座標為「相對該頁的比例值」（0~1，原點左上、y 向下，同瀏覽器慣例）。
// 送簽時由點點簽 adapter 轉成 PDF points（原點左下）。
export interface SignatureField {
  id: string;
  signer: SignerRole;
  // 簽署席位（ADR-0021 決議 5）：值是規則列的 rule_id。居間加包租時有兩位執業人員，靠它區分。
  // 選填。舊資料沒有，以簽署角色對應（歸該角色的第一個席位）。
  slot?: string;
  page: number; // 0-based
  x: number;
  y: number;
  w: number;
  h: number;
}

// 合約完成時向點點簽取回並隨合約保存的兩份文件（規格第 9 節）
export const CONTRACT_FILE_KINDS = ['signed_pdf', 'audit_trail'] as const;
export type ContractFileKind = (typeof CONTRACT_FILE_KINDS)[number];

export const CONTRACT_FILE_LABELS: Record<ContractFileKind, string> = {
  signed_pdf: '已簽 PDF',
  audit_trail: 'Audit Trail File',
};

export type ContractFileStatus = 'saved' | 'failed';

// 保存結果一律入庫：成功記檔案資訊，失敗記錯誤訊息供補抓
export interface ContractFile {
  id: number;
  contract_id: number;
  kind: ContractFileKind;
  status: ContractFileStatus;
  file_name: string;
  rel_path: string | null; // 相對 data/ 的路徑，失敗時為 null
  byte_size: number | null;
  content_type: string | null;
  error: string | null;
  saved_at: string;
}

interface ContractBase {
  id: number;
  property_id: number | null;
  status: ContractStatus;
  signature_fields: SignatureField[];
  declined_reason: string | null;
  // 衍生自哪份合約（ADR-0006）：只有「撤回後複製為新草稿」的修約路徑會記錄，拒簽後的複製為 null
  derived_from: number | null;
  created_at: string;
  updated_at: string | null;
}

// 合約類型（ADR-0021 決議 2）：決定簽章分流的文件類型與欄位形狀。既有合約一律是 lease。
export interface LeaseContract extends ContractBase {
  contract_type: 'lease';
  fields: LeaseContractFields;
}

export interface ManagementContract extends ContractBase {
  contract_type: 'management';
  fields: ManagementContractFields;
}

/** 合約：以 `contract_type` 判別的聯集，欄位形狀跟著類型走。 */
export type Contract = LeaseContract | ManagementContract;

// 衍生鏈上的一份合約（詳情頁「關聯合約」分頁只需編號與狀態）
export interface ContractRelationRef {
  id: number;
  status: ContractStatus;
}

// 一份合約的衍生關聯：前身（本約衍生自誰）與後繼（誰衍生自本約）
export interface ContractRelations {
  derived_from: ContractRelationRef | null;
  derived_contracts: ContractRelationRef[];
}

// 合約歷程（見 GLOSSARY.md、ADR-0007）：附屬合約的 append-only 里程碑事件。
// 只記這八種；草稿編輯流水與下載／查看等讀式操作不記。
export const CONTRACT_EVENT_TYPES = [
  'created', // 建立（衍生自撤回合約時附註來源）
  'sent', // 送簽
  'tenant_signed', // 乙方簽署。舊資料專用，只保留顯示，新事件用 signer_signed
  'signer_signed', // 簽署人簽署，行為者為該位角色
  'declined', // 拒簽（附註原因）
  'completed', // 簽署完成
  'voided', // 撤回
  'copied', // 被複製為新草稿
] as const;
export type ContractEventType = (typeof CONTRACT_EVENT_TYPES)[number];

export const CONTRACT_EVENT_TYPE_LABELS: Record<ContractEventType, string> = {
  created: '建立合約',
  sent: '送簽',
  tenant_signed: '乙方簽署',
  signer_signed: '簽署人簽署',
  declined: '拒簽',
  completed: '簽署完成',
  voided: '撤回',
  copied: '被複製為新草稿',
};

// 簽署人的行為者一律用簽署角色。landlord 是送簽與撤回的發動者，tenant 只有舊資料。
export const CONTRACT_EVENT_ACTORS = ['landlord', 'tenant', 'system', ...SIGNER_ROLES] as const;
export type ContractEventActor = (typeof CONTRACT_EVENT_ACTORS)[number];

export const CONTRACT_EVENT_ACTOR_LABELS: Record<ContractEventActor, string> = {
  landlord: TERMS.lessor,
  tenant: TERMS.lessee,
  system: '系統',
  ...SIGNER_ROLE_LABELS,
};

export interface ContractEvent {
  id: number;
  contract_id: number;
  type: ContractEventType;
  actor: ContractEventActor;
  note: string | null;
  created_at: string;
}
