// 標籤對照表（MIL-122）：介面與文件上的稱謂一律從這裡取字。
// 用詞來源：GLOSSARY「角色與合約地位」、PRD 0.2 與 P0-01。只匯出純函式與常數。

/** 合約類型（ADR-0021 決議 2）。 */
export type ContractType = 'lease' | 'management';

/** 稱謂的單一來源。其他常數與函式都從這裡組字，不另寫字串。 */
export const TERMS = {
  partyA: '甲方',
  partyB: '乙方',
  lessor: '出租人',
  lessee: '承租人',
  mandator: '委託人',
  mandatary: '受託人',
} as const;

export interface PartyLabels {
  /** 甲方的稱謂，例如「出租人」。 */
  partyA: string;
  /** 乙方的稱謂，例如「承租人」。 */
  partyB: string;
  /** 帶括號的完整寫法，例如「甲方（出租人）」。 */
  partyAFull: string;
  partyBFull: string;
}

const PARTY_TITLES: Record<ContractType, { partyA: string; partyB: string }> = {
  lease: { partyA: TERMS.lessor, partyB: TERMS.lessee },
  management: { partyA: TERMS.mandator, partyB: TERMS.mandatary },
};

/** 甲方與乙方的稱謂依合約類型決定（GLOSSARY「甲方」「乙方」）。 */
export function partyLabels(contractType: ContractType): PartyLabels {
  const { partyA, partyB } = PARTY_TITLES[contractType];
  return {
    partyA,
    partyB,
    partyAFull: `${TERMS.partyA}（${partyA}）`,
    partyBFull: `${TERMS.partyB}（${partyB}）`,
  };
}

/** 業別（ADR-0017 決議 5）。一個執業主體得兼營多種業別。 */
export type LicenseKind = 'management' | 'master_lease' | 'brokerage';

/** 案件的業務類型：自管、代管、包租（GLOSSARY「業務類型」）。 */
export type BusinessType = 'self_managed' | 'managed' | 'master_lease';

/** 證書種類（MIL-61 統一識別字）。 */
export type CertificateKind =
  | 'rental_housing_manager'
  | 'real_estate_broker'
  | 'real_estate_sales_agent';

const LICENSE_TITLES: Record<LicenseKind, string> = {
  management: '租賃住宅代管業者',
  master_lease: '租賃住宅包租業者',
  brokerage: '不動產經紀業者',
};

/** 案件的業務類型要求哪一種業別。自管不要求任何業別。 */
const REQUIRED_LICENSE: Record<BusinessType, LicenseKind | null> = {
  self_managed: null,
  managed: 'management',
  master_lease: 'master_lease',
};

/**
 * 執業主體的法定稱謂（PRD 0.2、P0-01 AC2、AC5）。
 * 只有一種業別時，稱謂由業別決定，業務類型不影響。
 * 兼營時，稱謂由案件的業務類型決定：代管案件用代管業者，包租案件用包租業者。
 * 兼營卻無法由業務類型決定時拋 RangeError，不猜稱謂。
 */
export function statutoryTitle(
  licenseKind: LicenseKind | readonly LicenseKind[],
  businessType?: BusinessType,
): string {
  const kinds = [...new Set(typeof licenseKind === 'string' ? [licenseKind] : licenseKind)];
  if (kinds.length === 0) throw new RangeError('statutoryTitle：至少要有一種業別');
  if (kinds.length === 1) return LICENSE_TITLES[kinds[0]];

  const required = businessType ? REQUIRED_LICENSE[businessType] : null;
  if (required && kinds.includes(required)) return LICENSE_TITLES[required];
  throw new RangeError(
    `statutoryTitle：兼營 ${kinds.join('、')} 時，業務類型 ${businessType ?? '未提供'} 無法決定稱謂`,
  );
}

const PRACTITIONER_TITLES: Record<CertificateKind, string> = {
  rental_housing_manager: '租賃住宅管理人員',
  real_estate_broker: '不動產經紀人',
  real_estate_sales_agent: '不動產經紀營業員',
};

/** 執業人員依證書種類的法定稱謂（GLOSSARY「法定稱謂」）。 */
export function practitionerTitle(certificateKind: CertificateKind): string {
  return PRACTITIONER_TITLES[certificateKind];
}

/**
 * 介面與文件禁用的舊用詞（MIL-122 AC7）。給之後的 lint 測試用。
 * - everywhere：所有介面字串都禁用。
 * - contractPdfAndLessee：合約 PDF、承租人端與標章的字串另外禁用。
 * - exemptPhrases：含禁用詞作為子字串的合法詞，掃描時先排除。
 */
export const LEGACY_TERMS = {
  everywhere: ['房東', '租客', '房客', '出租方', '承租方', '業主'],
  contractPdfAndLessee: ['經理人'],
  exemptPhrases: ['執業主體'],
} as const;
