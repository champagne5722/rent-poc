// 移交包的六類索引與缺項（MIL-94「六類內容」、P0-22 規則 6）。
// 純函式，不讀資料。雜湊在 snapshot-hash.ts，因為它要用 node:crypto，這個檔案得給 client 用。

export interface SignedDocRef {
  id: string;
  /** 已簽 PDF 的 SHA-256。 */
  signedPdfSha256: string;
}

export interface AttachmentRef {
  id: string;
  name: string;
}

export interface UnpaidPeriodRef {
  periodId: string;
  /** YYYY-MM */
  month: string;
  remaining: number;
}

export interface RepairRef {
  id: string;
  title: string;
  status: 'reported' | 'in_progress' | 'done';
}

/** 發起者手填的欄位。沒填就是空字串。 */
export interface HandoverManualFields {
  keyHandover: string;
  accessCardHandover: string;
  committeeContact: string;
}

/**
 * 產生快照需要的事實。null 表示來源沒有資料。
 * 陣列是空的表示「確實沒有」：沒有欠費、沒有修繕不算缺項，附件是空的算缺項。
 */
export interface HandoverSnapshotFacts {
  handoverId: string;
  rentalUnitId: string;
  /** 委託標的清單上沒有租賃案件的單位是 false，租約、點交與帳務不適用。 */
  hasLeaseCase: boolean;
  title: { leaseAuthorityStatus: string | null; transcriptFetchedAt: string | null };
  people: { managementContract: SignedDocRef | null; leaseContract: SignedDocRef | null };
  condition: {
    moveInRecord: AttachmentRef | null;
    conditionAttachments: AttachmentRef[];
    equipmentAttachments: AttachmentRef[];
  };
  money: {
    depositBalance: number | null;
    prepaidRentBalance: number | null;
    unpaidPeriods: UnpaidPeriodRef[] | null;
    uncollectedRemittance: number | null;
  };
  repairs: RepairRef[] | null;
  manual: HandoverManualFields;
}

export type SnapshotCategoryKey = 'title' | 'people' | 'condition' | 'money' | 'physical' | 'admin';

export type SnapshotItemStatus = 'present' | 'missing' | 'not_applicable';

export interface SnapshotItem {
  key: string;
  label: string;
  status: SnapshotItemStatus;
  /** 只有 present 時有值。 */
  value: unknown;
}

export interface SnapshotCategory {
  key: SnapshotCategoryKey;
  label: string;
  items: SnapshotItem[];
}

export interface MissingItem {
  /** `類別.項目`，屋主勾選知悉時用這個鍵。 */
  key: string;
  category: string;
  label: string;
}

export interface HandoverSnapshot {
  handoverId: string;
  rentalUnitId: string;
  categories: SnapshotCategory[];
  missing: MissingItem[];
}

type ItemSpec = { key: string; label: string; value: unknown; leaseOnly?: boolean };

function hasData(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/** 缺項鍵 `類別.項目`。屋主勾選知悉與索引檔都用這個鍵。 */
export function missingKey(categoryKey: SnapshotCategoryKey, itemKey: string): string {
  return `${categoryKey}.${itemKey}`;
}

export function buildHandoverSnapshot(facts: HandoverSnapshotFacts): HandoverSnapshot {
  const { title, people, condition, money, manual } = facts;
  // 附件清單是空的就是沒有資料
  const attachments = (list: AttachmentRef[]) => (list.length > 0 ? list : null);

  const specs: { key: SnapshotCategoryKey; label: string; items: ItemSpec[] }[] = [
    {
      key: 'title',
      label: '權屬',
      items: [
        { key: 'lease_authority', label: '出租權源', value: title.leaseAuthorityStatus },
        { key: 'transcript', label: '謄本取得時間', value: title.transcriptFetchedAt },
      ],
    },
    {
      key: 'people',
      label: '人',
      items: [
        { key: 'management_contract', label: '委託管理合約', value: people.managementContract },
        { key: 'lease_contract', label: '現任承租人的租賃合約', value: people.leaseContract, leaseOnly: true },
      ],
    },
    {
      key: 'condition',
      label: '屋況',
      items: [
        { key: 'move_in', label: '點交紀錄', value: condition.moveInRecord, leaseOnly: true },
        {
          key: 'condition_attachments',
          label: '現況確認附件',
          value: attachments(condition.conditionAttachments),
          leaseOnly: true,
        },
        {
          key: 'equipment_attachments',
          label: '設備附件',
          value: attachments(condition.equipmentAttachments),
          leaseOnly: true,
        },
      ],
    },
    {
      key: 'money',
      label: '錢',
      items: [
        { key: 'deposit', label: '押金餘額', value: money.depositBalance, leaseOnly: true },
        { key: 'prepaid_rent', label: '預收租金餘額', value: money.prepaidRentBalance, leaseOnly: true },
        { key: 'unpaid_periods', label: '未足額期別', value: money.unpaidPeriods, leaseOnly: true },
        { key: 'uncollected_remittance', label: '代收未交付', value: money.uncollectedRemittance, leaseOnly: true },
      ],
    },
    {
      key: 'physical',
      label: '實物',
      items: [
        { key: 'keys', label: '鑰匙交付紀錄', value: manual.keyHandover },
        { key: 'access_cards', label: '門禁卡交付紀錄', value: manual.accessCardHandover },
      ],
    },
    {
      key: 'admin',
      label: '行政',
      items: [
        { key: 'repairs', label: '修繕紀錄', value: facts.repairs },
        { key: 'committee_contact', label: '管委會窗口', value: manual.committeeContact },
      ],
    },
  ];

  const categories: SnapshotCategory[] = specs.map((category) => ({
    key: category.key,
    label: category.label,
    items: category.items.map((item): SnapshotItem => {
      if (item.leaseOnly && !facts.hasLeaseCase) {
        return { key: item.key, label: item.label, status: 'not_applicable', value: null };
      }
      if (!hasData(item.value)) return { key: item.key, label: item.label, status: 'missing', value: null };
      const value = typeof item.value === 'string' ? item.value.trim() : item.value;
      return { key: item.key, label: item.label, status: 'present', value };
    }),
  }));

  const missing = categories.flatMap((category) =>
    category.items
      .filter((item) => item.status === 'missing')
      .map((item) => ({ key: missingKey(category.key, item.key), category: category.label, label: item.label })),
  );

  return { handoverId: facts.handoverId, rentalUnitId: facts.rentalUnitId, categories, missing };
}
