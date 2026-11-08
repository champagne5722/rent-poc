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
