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
 * 物件對外的文件核對狀態（ADR-0028 決議 2，MIL-201）。只由所有權節點決定，不讀 registry.anchors.status。
 * 待平台核對文件：還沒送文件、文件待核對，或節點已失效。已核對：說明文字固定為「平台已比對出租權源文件」。
 * 文件不符：兩項比對有一項不符，使用者修正後能重新送出。
 */
export const PROPERTY_VERIFICATION_STATUSES = ['pending_verification', 'verified', 'failed'] as const;
export type PropertyVerificationStatus = (typeof PROPERTY_VERIFICATION_STATUSES)[number];

/** 所有權節點的狀態（ADR-0026 決議 2）。轉移規則在 src/lib/ownership/status.ts。 */
export type OwnershipNodeStatus = 'pending_verification' | 'verified' | 'failed' | 'lapsed';

/** 謄本顯示信託登記時，使用者補的四項資料（ADR-0026 決議 1）。 */
export interface OwnershipTrustView {
  registered_owner: string;
  related_parties: string;
  registration_status: string;
  lease_clause: string;
}

/** 一次謄本送件。不含原檔的 key 與 SHA-256：原檔只經 GET /api/properties/[id]/ownership/file 讀，每次讀取寫稽核事件。 */
export interface OwnershipSubmissionView {
  id: string;
  seq: number;
  /** 使用者主張的所有權人（使用者自己填的），不是謄本上的姓名。 */
  claimed_owner_name: string;
  /** 謄本的取得時間。 */
  acquired_at: string;
  submitted_at: string;
  /** 謄本沒有信託登記時是 null。 */
  trust: OwnershipTrustView | null;
  file_name: string;
  content_type: string;
  byte_size: number;
}

// ---------------------------------------------------------------------------
// 兩方都通過核對時的衝突個案（MIL-208）。只給平台營運者的審核台，組織的 API 不回這些型別。

/** 營運者的三種決定。 */
export type OwnershipConflictDecision = 'later_prevails' | 'later_rejected' | 'coexist';
/** 後來的不成立時，記成哪一項不符（走既有的驗證失敗訊息）。 */
export type OwnershipConflictBasis = 'key_mismatch' | 'holder_mismatch' | 'both_mismatch';
export type OwnershipConflictContactTarget = 'earlier' | 'later';
export type OwnershipConflictContactChannel = 'phone' | 'email' | 'other';

export interface OwnershipConflictContact {
  id: string;
  target: OwnershipConflictContactTarget;
  channel: OwnershipConflictContactChannel;
  outcome: string;
  contactedAt: string;
  recordedBy: string;
  recordedAt: string;
}

/** 衝突的一方。只有判定所需的欄位：遮罩的登記名義人、通過核對或送件的時間、取得時間、檔案的參照。 */
export interface OwnershipConflictSide {
  orgId: string;
  orgName: string | null;
  nodeId: string;
  submissionId: string | null;
  holderMasked: string | null;
  /** 先前的一方：通過核對的時間。後來的一方沒有。 */
  verifiedAt: string | null;
  /** 先前的一方：謄本的取得時間（讀它的組織取得）。後來的一方的取得時間在項目詳情的 submission。 */
  acquiredAt: string | null;
}

export interface OwnershipConflictView {
  id: string;
  itemId: string;
  status: 'open' | 'decided';
  createdAt: string;
  decision: OwnershipConflictDecision | null;
  decisionBasis: OwnershipConflictBasis | null;
  decisionReason: string | null;
  /** later_prevails 才有值：先前的一方進行中的案件數。其餘是 0。 */
  affectedCaseCount: number | null;
  decidedBy: string | null;
  decidedAt: string | null;
  claimedKey: { cityCode: string; townCode: string; sectionCode: string; buildingNo: string; subNo: string };
  later: OwnershipConflictSide;
  earlier: OwnershipConflictSide;
  contacts: OwnershipConflictContact[];
}

/**
 * 物件頁「所有權文件」的狀態（MIL-201，GET /api/properties/[id]/ownership）。
 * 只含呼叫者自己組織的資料。別的組織是否登錄過同一個鍵、核對是否因此停住，這裡看不出來（ADR-0028 決議 1）。
 */
export interface PropertyOwnership {
  property_id: string;
  /** 對外的核對狀態。畫面用狀態呈現表的 propertyVerification。 */
  verification_status: PropertyVerificationStatus;
  /** 節點狀態。還沒送過文件是 null。 */
  node_status: OwnershipNodeStatus | null;
  /** 給使用者看的固定文字，依序顯示。驗證失敗時是不符項目對應的訊息，文字在 src/lib/ownership/messages.ts。 */
  messages: string[];
  /** 已核對時固定為「平台已比對出租權源文件」，其餘是 null。 */
  verified_note: string | null;
  checked_at: string | null;
  /** 營運者照謄本填的已遮罩登記名義人。只在已核對或驗證失敗時有值。 */
  holder_masked: string | null;
  /** 最新一次送件。 */
  submission: OwnershipSubmissionView | null;
  submission_count: number;
  has_key: boolean;
  /** 能送出謄本：有建號、物件未封存，而且沒有節點或節點驗證失敗。 */
  can_submit: boolean;
  /** 謄本與身分證件個資告知。agreed 為 true 才能開啟上傳頁。 */
  consent: { notice_type: string; version: number; title: string; text: string; agreed: boolean };
}

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

/**
 * 物件列表依物件分組時，組內的一個租賃單位（MIL-202）。欄位同 Property，
 * 但建號與核對狀態屬於物件，放在 PropertyGroup，單位不重複帶。
 */
export type PropertyGroupUnit = Omit<Property, 'anchor' | 'verification_status'>;

/**
 * 物件列表的一筆：一個物件，底下是呼叫者組織自己的租賃單位（MIL-202，GET /api/properties?group=object）。
 * - id 是組內整戶單位的營運資料 ID（org.properties.id）。沒有整戶時是後綴最小的單位。
 *   用它對應到建案入口：它就是 units 裡某一項的 id。
 * - 不含登記庫的建號節點 ID，也不含別的組織的資料。
 * - address 與 anchor 取自代表單位（同 id 的那一項）。
 */
export interface PropertyGroup {
  id: string;
  /** 物件對外的文件核對狀態。畫面一律用狀態呈現表的 propertyVerification。 */
  verification_status: PropertyVerificationStatus;
  anchor: PropertyAnchor | null;
  address: string;
  /** 依後綴排序，整戶（0000）在前。被合併的單位解析到存續單位，同一個存續單位只留一筆。封存的單位照樣列出。 */
  units: PropertyGroupUnit[];
}

/** 從物件建立案件時能選的案件種類（MIL-209，ADR-0030）。委託管理案件不綁單一物件，不在內。 */
export type PropertyCaseKind = 'lease' | 'master_lease' | 'sublease';

/** `GET /api/properties/[id]` 的 `data`：物件加上目前組織能建立的案件種類。未核對是空陣列。 */
export interface PropertyDetail extends Property {
  available_case_kinds: PropertyCaseKind[];
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

/**
 * 租賃類合約（租賃、包租、轉租）共用的欄位（MIL-199）：兩方當事人、物件快照、租金、押金、租期與設備附件。
 * 三種合約各有自己的欄位型別，共用這一份。甲方是出租的一方，乙方是承租的一方：
 * 租賃合約是出租人與承租人，包租合約是出租人與包租業，轉租合約是包租業與承租人（GLOSSARY「甲方」「乙方」）。
 * 欄位名稱沿用 landlord 與 tenant，指的是位置，不是法定稱謂。
 */
export interface LeaseTermsFields extends ContractFieldsBase, EquipmentAnnexSnapshot {
  landlordName: string; // 甲方（出租的一方）
  landlordEmail: string;
  tenantName: string; // 乙方（承租的一方）
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

// 租賃合約欄位值：建立時由物件帶入快照，之後與物件脫鉤（見 docs/domain-model.md）
export interface LeaseContractFields extends LeaseTermsFields {
  /**
   * 現況確認附件的內容（MIL-71）。包租租賃合約必附，其他組合不顯示也不印。
   * 選填：送簽前就存在的舊合約沒有這個鍵，讀入不報錯，送簽後的舊合約 PDF 也不會多出附件頁。
   */
  statusAnnex?: StatusAnnex;
}

/** 費用項目：住宅包租契約與住宅轉租契約的「租賃期間相關費用之支付」逐項約定負擔人。 */
export const LEASE_FEE_ITEMS = ['management', 'water', 'electricity', 'gas', 'internet'] as const;
export type LeaseFeeItem = (typeof LEASE_FEE_ITEMS)[number];

/** 一方當事人的聯絡資料。公告要求載明的資料，平台目前沒有蒐集的部分先留空，條文印底線。待法務確認（MIL-62）。 */
export interface LeasePartyContact {
  /** 個人：戶籍地址。公司：營業地址。 */
  registeredAddress?: string;
  mailingAddress?: string;
  phone?: string;
  /** 公司才填：代表人姓名、統一編號、租賃住宅服務業登記證字號。 */
  representative?: string;
  taxId?: string;
  licenseNo?: string;
}

/** 租賃住宅管理人員的資料。公告要求載明證書字號，ADR-0018 決議 14 決定簽署欄不印證號，這裡只在有填時印。 */
export interface LeaseManagerContact {
  name?: string;
  certificateNo?: string;
  mailingAddress?: string;
  phone?: string;
  email?: string;
}

/**
 * 住宅包租契約與住宅轉租契約的選項型約定（MIL-199）。公告的應約定事項與應記載事項有許多「□…□…」的選項，
 * 這裡存逐約的選擇。全部可選：沒填時用 `lease-family-terms.ts` 的預設值，預設值都待法務確認。
 * 甲方與乙方是合約位置：包租合約的甲方是出租人、乙方是包租業，轉租合約的甲方是包租業、乙方是承租人。
 * 建約精靈目前沒有編輯這些欄位的畫面，欄位由後續的票接上。
 */
export interface LeaseFamilyTerms {
  /** 租賃範圍：全部或一部。一部時在 scopeNote 寫房間與位置。 */
  scope?: 'whole' | 'part';
  scopeNote?: string;
  /** 土地與建物登記資料、車位、他項權利與查封登記的說明（公告租賃標的第一款的各目）。 */
  titleNote?: string;
  rentPaymentMethod?: 'cash' | 'transfer' | 'other';
  /** 轉帳時寫金融機構、戶名與帳號。其他方式時寫方式。 */
  rentPaymentNote?: string;
  /** 各費用項目由甲方或乙方負擔。 */
  feePayers?: Partial<Record<LeaseFeeItem, 'party_a' | 'party_b'>>;
  /** 管理費的月額（元）。 */
  managementFeeMonthly?: number | null;
  parkingFeeMonthly?: number | null;
  /** 其他費用及其支付方式。 */
  otherFeesNote?: string;
  /** 轉租合約：電費由承租人負擔時的計費方式。 */
  electricityBilling?: 'per_kwh' | 'per_period';
  /** 包租合約：出租人是否同意包租業以出借或轉租以外的方式供他人居住使用。 */
  otherUse?: 'allowed' | 'not_allowed';
  /** 包租合約：出租人是否同意包租業室內裝修。 */
  renovation?: 'allowed' | 'not_allowed';
  /** 包租合約：室內裝修費用由誰負擔。 */
  renovationCostPayer?: 'party_a' | 'party_b';
  /** 返還時回復原狀或現況返還。 */
  restoreOnReturn?: 'restore' | 'as_is';
  /** 租期屆滿前雙方得否終止租約。 */
  earlyTermination?: 'allowed' | 'not_allowed';
  /** 是否辦理公證，及公證後是否同意逕受強制執行。 */
  notarization?: 'agreed' | 'not_agreed';
  /** 修繕責任的項目與範圍（包租合約是出租人負擔修繕費用的項目，轉租合約是包租業負責修繕的項目）。 */
  repairScopeNote?: string;
  partyA?: LeasePartyContact;
  partyB?: LeasePartyContact;
  manager?: LeaseManagerContact;
}

/**
 * 包租合約欄位值（MIL-199）：屋主（出租人，甲方）把租賃單位出租給包租業者（包租業，乙方）並同意它轉租。
 * 法定文件名是住宅包租契約，條文依內政部公告，見 `master-lease-clauses.ts`。
 * 不附現況確認附件（ADR-0030 決議 6）。
 */
export interface MasterLeaseContractFields extends LeaseTermsFields {
  terms?: LeaseFamilyTerms;
}

/**
 * 轉租合約欄位值（MIL-199）：包租業者（包租業，甲方）把承租的租賃單位轉租給承租人（乙方）。
 * 法定文件名是住宅轉租契約，條文依內政部公告，見 `sublease-clauses.ts`。
 * 現況確認附件跟著轉租合約（ADR-0030 決議 6），內容存在 `statusAnnex`。
 */
export interface SubleaseContractFields extends LeaseTermsFields {
  statusAnnex?: StatusAnnex;
  terms?: LeaseFamilyTerms;
  /** 包租契約的租賃期間（YYYY-MM-DD）。轉租期間不得逾包租契約的租賃期間，有填時檢核。 */
  masterLeaseStart?: string;
  masterLeaseEnd?: string;
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
export type ContractFields =
  | LeaseContractFields
  | ManagementContractFields
  | MasterLeaseContractFields
  | SubleaseContractFields;

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

export interface MasterLeaseContract extends ContractBase {
  contract_type: 'master_lease';
  fields: MasterLeaseContractFields;
}

export interface SubleaseContract extends ContractBase {
  contract_type: 'sublease';
  fields: SubleaseContractFields;
}

/** 合約：以 `contract_type` 判別的聯集，欄位形狀跟著類型走。 */
export type Contract = LeaseContract | ManagementContract | MasterLeaseContract | SubleaseContract;

/** 租賃類合約：租賃、包租、轉租。兩方當事人、租金、押金與租期的欄位相同（`LeaseTermsFields`），案件與帳務的處理也相同。 */
export type LeaseFamilyContract = LeaseContract | MasterLeaseContract | SubleaseContract;

/** 租賃類合約的類型。 */
export const LEASE_FAMILY_TYPES = ['lease', 'master_lease', 'sublease'] as const;

export function isLeaseFamilyContract(contract: Contract): contract is LeaseFamilyContract {
  return (LEASE_FAMILY_TYPES as readonly string[]).includes(contract.contract_type);
}

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

// ---------------------------------------------------------------------------
// 申請：委託管理申請與住宅包租申請（MIL-206，spec MIL-193，ADR-0029、ADR-0030）
// 路徑在 src/app/api/mandate-requests。業者端與屋主端各有一種形狀：業者端沒有屋主的任何資料，
// 所以「沒人打開」「有人打開」「已綁定但沒送出」三種情況在業者端的回應逐位元相同。

export const MANDATE_REQUEST_KINDS = ['management', 'master_lease'] as const;
/** management 是委託管理申請，master_lease 是住宅包租申請。 */
export type MandateRequestKind = (typeof MANDATE_REQUEST_KINDS)[number];

/** 讀取時判定的狀態：待屋主確認、待業者接受、已接受、未接受、已收回、已結束、已完成，加上依期限判定的失效。 */
export type MandateRequestStatus =
  | 'pending_owner'
  | 'pending_practice'
  | 'accepted'
  | 'declined'
  | 'withdrawn'
  | 'ended'
  | 'completed'
  | 'expired';

/** 業者代填的房子資料。欄位集合與登錄物件的請求本文相同，屋主確認時由登錄入口重新驗證。 */
export interface MandateRequestDraft {
  name: string;
  address: string;
  type?: PropertyType;
  size?: number | null;
  default_rent?: number | null;
  note?: string;
  equipment?: EquipmentItem[];
  anchor?: {
    key?: { city: string; town: string; section: string; buildingNo: string; subNo?: string };
    latitude?: number | null;
    longitude?: number | null;
  };
}

/** 業者代傳謄本時填的謄本表單欄位（與物件頁上傳謄本相同）。 */
export interface MandateRequestTranscriptForm {
  claimed_owner: string;
  acquired_at: string;
  has_trust?: boolean;
  trust_registered_owner?: string;
  trust_related_parties?: string;
  trust_registration_status?: string;
  trust_lease_clause?: string;
}

/** 業者端讀到的申請（GET /api/mandate-requests、GET /api/mandate-requests/[id]）。不含屋主的任何資料。 */
export interface PracticeMandateRequest {
  id: string;
  kind: MandateRequestKind;
  /** 法定名稱：委託管理申請、住宅包租申請。 */
  kind_label: string;
  status: MandateRequestStatus;
  created_at: string;
  /** 目前仍有效的期限。已完成、已收回、未接受、已結束、已失效是 null。 */
  deadline: string | null;
  submitted_at: string | null;
  withdrawn_at: string | null;
  /** 業者自己代填的資料。連結失效後是 null。 */
  draft: MandateRequestDraft | null;
  transcript_file_name: string | null;
  /** 屋主送出後才有數字。送出前是 null。 */
  unit_count: number | null;
}

/** 產生連結的回應（POST /api/mandate-requests，201）。碼與連結只在這一次回應出現，之後沒有地方能取回。 */
export interface MandateRequestCreated extends PracticeMandateRequest {
  /** 站內路徑 /request/<碼>。畫面組成完整網址與 QR code。 */
  link_path: string;
}

/** 登入前的連結頁（GET /api/mandate-requests/link/[code]）。只有業者的公開資訊。 */
export interface MandateRequestLinkView {
  kind: MandateRequestKind;
  kind_label: string;
  practice: { name: string; tax_id: string; verified_kinds: string[] };
  expires_at: string;
}

/** 屋主端讀到的申請（GET /api/mandate-requests/[id]）。 */
export interface OwnerMandateRequest {
  id: string;
  kind: MandateRequestKind;
  kind_label: string;
  status: MandateRequestStatus;
  created_at: string;
  deadline: string | null;
  submitted_at: string | null;
  withdrawn_at: string | null;
  practice: { name: string; tax_id: string; verified_kinds: string[] };
  /** 業者代填的資料。屋主確認前的待確認內容。連結失效或送出後是 null。 */
  draft: MandateRequestDraft | null;
  has_transcript: boolean;
  /** 屋主已確認代填資料。確認後登錄的租賃單位 ID。 */
  confirmed_unit_id: string | null;
  /** 已送出的申請含的租賃單位。 */
  unit_ids: string[];
  /** 這份申請的個資告知文字，屋主確認代填資料時必須顯示。 */
  consent_notice: { notice_type: string; version: number; title: string; text: string } | null;
}
