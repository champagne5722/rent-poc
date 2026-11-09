// 現況確認附件的型別（MIL-71）。純型別，types.ts 可以安全引用。

/** 每列的狀態。尚未填寫是 null，送簽前必須填完。 */
export const STATUS_ANNEX_STATUSES = ['normal', 'defect', 'not_applicable'] as const;
export type StatusAnnexStatus = (typeof STATUS_ANNEX_STATUSES)[number];

/**
 * 附件的一列。標籤在建立時快照進來，之後項目清單改版不回溯影響已存的內容（比照 ADR-0005 的條款快照）。
 */
export interface StatusAnnexRow {
  /** 項目識別字，取自 STATUS_ANNEX_ITEMS。 */
  id: string;
  label: string;
  status: StatusAnnexStatus | null;
  note: string;
}

/** 現況確認附件的內容。收在 `LeaseContractFields.statusAnnex`，隨草稿保存，送簽後不再改動。 */
export interface StatusAnnex {
  /** 項目清單的版本，值是建立當時的 STATUS_ANNEX_VERSION。 */
  version: number;
  rows: StatusAnnexRow[];
}
