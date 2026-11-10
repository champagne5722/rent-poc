// 領域型別與詞彙，術語定義見 repo 根目錄 GLOSSARY.md

import type { BusinessType } from './cases';
import { TERMS } from './labels';
import type { StatusAnnex } from './status-annex/types';

export const PROPERTY_TYPES = ['整層住家', '套房', '雅房'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

// 設備詞彙庫的平台預設項目（ADR-0008）：每個組織第一次用到詞彙庫時，由 properties 的 repository 補進 org.equipment_vocabulary，
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
  id: string; // ULID（ADR-0012 決議 9）
  name: string;
  is_custom: boolean;
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

/**
 * 物件對外的文件核對狀態（ADR-0028 決議 2）。只由文件核對決定，不讀 registry.anchors.status。
 * 目前沒有核對功能，所以只有「待平台核對文件」一種。MIL-201 加入「已核對」與「文件不符」。
 */
export const PROPERTY_VERIFICATION_STATUSES = ['pending_verification'] as const;
export type PropertyVerificationStatus = (typeof PROPERTY_VERIFICATION_STATUSES)[number];

/**
 * 物件頁的建號區塊用的物件摘要（MIL-143）。不含物件的 registry ID：它是跨組織的全域資料，畫面用不到。
 * 沒有填建號的舊資料，五欄鍵與名稱都是 null。名稱一律是「臺」，來自 registry 的參照表。
 * 鍵是使用者自己填的鍵。就算它與別的組織重複，這裡仍是使用者填的鍵（ADR-0028 決議 2）。
 * 不含內部狀態：keyed 與 pending_verification 的差別只留在資料庫，對外不得出現。
 */
export interface PropertyAnchor {
  city_code: string | null;
  town_code: string | null;
  section_code: string | null;
  building_no: string | null;
  sub_no: string | null;
  city_name: string | null;
  town_name: string | null;
  /** 段名加小段名，例如「龍泉 一」。 */
  section_name: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** 租賃單位類型與狀態（ADR-0013 決議 5、6，ADR-0025 決議 14）。whole 是整戶，後綴固定 0000。 */
export const RENTAL_UNIT_TYPES = ['whole', 'sublet'] as const;
export type RentalUnitType = (typeof RENTAL_UNIT_TYPES)[number];
export const RENTAL_UNIT_STATUSES = ['active', 'merged', 'retired'] as const;
export type RentalUnitStatus = (typeof RENTAL_UNIT_STATUSES)[number];

/**
 * 物件持有的租賃單位摘要（MIL-145）。不含單位 ID 與錨點 ID 之外的跨組織資料。
 * 顯示編碼不含段碼與建號（R13）。沒有填建號的舊資料沒有縣市與鄉鎮編碼，顯示編碼是 null，補建號後才產生。
 */
export interface PropertyUnit {
  /** 單位後綴 4 碼，整戶 `0000`，分租從 `0001` 起。房號不是後綴。 */
  suffix: string;
  /** 房號或顯示名稱，只是標籤。整戶通常是 null。 */
  label: string | null;
  floor: string | null;
  unit_type: RentalUnitType;
  status: RentalUnitStatus;
  display_code: string | null;
}

/** 同一物件下，自己組織的一個租賃單位與它的營運資料（物件頁「單位」分頁）。 */
export interface SiblingUnit extends PropertyUnit {
  property_id: string;
  name: string;
  archived_at: string | null;
}

export interface Property {
  id: string; // ULID（ADR-0012 決議 9）
  // 物件持有的租賃單位，建物件時由 registry 同交易建立，不得為空（ADR-0013）
  rental_unit_id: string;
  /** 租賃單位摘要。讀不到時是 null（不應發生，畫面照樣能顯示）。 */
  unit: PropertyUnit | null;
  /** 封存時間。有任何合約的物件刪除時改為封存（P0-06 AC8）。封存的物件不得編輯與建約。 */
  archived_at: string | null;
  /** 租賃單位所屬物件的建號摘要。讀不到時是 null（不應發生，畫面照樣能顯示）。 */
  anchor: PropertyAnchor | null;
  /** 物件對外的文件核對狀態。畫面一律用狀態呈現表的 propertyVerification。 */
  verification_status: PropertyVerificationStatus;
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
  // 正式金鑰下，綁到未審閱範本的合約無法送簽（src/lib/template-review.ts）。
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
  /**
   * 現況確認附件的內容（MIL-71）。包租租賃合約必附，其他組合不顯示也不印。
   * 選填：送簽前就存在的舊合約沒有這個鍵，讀入不報錯，送簽後的舊合約 PDF 也不會多出附件頁。
   */
  statusAnnex?: StatusAnnex;
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

// 報酬約定的形式（MIL-74）。保守版本只有兩種：每月固定金額、每月租金百分比。待法務確認（MIL-62）。
export const MANAGEMENT_FEE_MODES = ['monthly_fixed', 'rent_percentage'] as const;
export type ManagementFeeMode = (typeof MANAGEMENT_FEE_MODES)[number];

export const MANAGEMENT_FEE_MODE_LABELS: Record<ManagementFeeMode, string> = {
  monthly_fixed: '每月固定金額（元）',
  rent_percentage: '每月租金百分比（%）',
};

/**
 * 委託管理合約欄位值（MIL-74）。委託人（甲方）與受託人（乙方）的姓名與 email、委託期間、報酬約定。
 * 受託人的執業主體與專任管理人員存在指派表（contract_practitioner_assignments），
 * 委託標的清單與委託範圍存在 contract_mandate_items（src/lib/mandate-schedule），不在欄位裡。
 * 受託人是執業主體時，乙方姓名與 email 由當事人簽署人帶入（ADR-0018 決議 2）。
 */
export interface ManagementContractFields extends ContractFieldsBase {
  mandatorName: string; // 委託人（甲方）
  mandatorEmail: string;
  mandataryName: string; // 受託人（乙方）
  mandataryEmail: string;
  termStart: string; // 委託期間起日 YYYY-MM-DD
  termEnd: string; // 委託期間迄日
  feeMode: ManagementFeeMode | null; // 報酬約定的形式
  feeValue: number | null; // 元，或租金的百分比
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
  contract_id: string; // 合約的 ULID
  kind: ContractFileKind;
  status: ContractFileStatus;
  file_name: string;
  sha256: string | null; // 檔案內容的 SHA-256，失敗時為 null
  byte_size: number | null;
  content_type: string | null;
  error: string | null;
  saved_at: string;
}

interface ContractBase {
  id: string; // ULID（ADR-0012 決議 9）。畫面顯示末 6 碼，用 shortUlid
  // 物件的 ULID，與合約同組織（複合外鍵 (org_id, property_id)）
  property_id: string | null;
  status: ContractStatus;
  signature_fields: SignatureField[];
  declined_reason: string | null;
  // 衍生自哪份合約（ADR-0006）：只有「撤回後複製為新草稿」的修約路徑會記錄，拒簽後的複製為 null
  derived_from: string | null;
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
  id: string;
  status: ContractStatus;
}

// 一份合約的衍生關聯：前身（本約衍生自誰）與後繼（誰衍生自本約）
export interface ContractRelations {
  derived_from: ContractRelationRef | null;
  derived_contracts: ContractRelationRef[];
}

// 合約歷程（見 GLOSSARY.md、ADR-0007）：附屬合約的 append-only 里程碑事件。
// 只記這十一種；草稿編輯流水與下載／查看等讀式操作不記。
export const CONTRACT_EVENT_TYPES = [
  'created', // 建立（衍生自撤回合約時附註來源）
  'sent', // 送簽
  'tenant_signed', // 乙方簽署。舊資料專用，只保留顯示，新事件用 signer_signed
  'signer_signed', // 簽署人簽署，行為者為該位角色
  'declined', // 拒簽（附註原因）
  'completed', // 簽署完成
  'voided', // 撤回
  'copied', // 被複製為新草稿
  'credential_lapsed', // 執業人員簽署時不可簽章（MIL-75，ADR-0018 決議 11）
  'auto_void_failed', // 簽署時不可簽章後，自動撤回失敗（MIL-75，ADR-0021 決議 7）
  'signers_merged', // 同一人兼任當事人簽署人與執業人員，送簽時合併成一位簽署人（MIL-76，ADR-0018 決議 9）
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
  credential_lapsed: '簽署時不可簽章',
  auto_void_failed: '自動撤回失敗',
  signers_merged: '同一人兼任，合併簽署人',
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
  id: string; // ULID，同一份合約內依 id 排序就是發生順序
  contract_id: string;
  type: ContractEventType;
  actor: ContractEventActor;
  note: string | null;
  created_at: string;
}
