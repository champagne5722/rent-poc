import { describe, expect, it } from 'vitest';
import {
  STATUS_ANNEX_ITEMS,
  STATUS_ANNEX_NOTE_MAX,
  STATUS_ANNEX_VERSION,
  defaultStatusAnnex,
  statusAnnexInputError,
  statusAnnexIssues,
  statusAnnexOf,
  statusAnnexRequired,
  statusAnnexSummary,
  type StatusAnnex,
} from './index';

// 現況確認附件（MIL-71、ADR-0018 決議 6 與 8）：固定項目清單、檢核、何時必附。
// 項目清單與必附條件都是待法務確認的假設（MIL-62）。

const MASTER_LEASE = { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false };

function filled(): StatusAnnex {
  const annex = defaultStatusAnnex();
  return { ...annex, rows: annex.rows.map((r) => ({ ...r, status: 'normal' as const })) };
}

describe('固定項目清單', () => {
  it('有版本，每項有唯一的識別字與標籤', () => {
    expect(STATUS_ANNEX_VERSION).toBe(1);
    const ids = STATUS_ANNEX_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(STATUS_ANNEX_ITEMS.length).toBeGreaterThanOrEqual(8);
    expect(STATUS_ANNEX_ITEMS.every((i) => i.label.length > 0)).toBe(true);
  });

  it('預設每列都尚未填狀態、備註空白，並凍結版本與標籤', () => {
    const annex = defaultStatusAnnex();
    expect(annex.version).toBe(STATUS_ANNEX_VERSION);
    expect(annex.rows).toHaveLength(STATUS_ANNEX_ITEMS.length);
    expect(annex.rows.every((r) => r.status === null && r.note === '')).toBe(true);
    expect(annex.rows.map((r) => r.label)).toEqual(STATUS_ANNEX_ITEMS.map((i) => i.label));
  });
});

describe('statusAnnexIssues：送簽前的完整性', () => {
  it('沒有內容時視為全部未填', () => {
    expect(statusAnnexIssues(undefined)).toEqual([`現況確認附件尚有 ${STATUS_ANNEX_ITEMS.length} 項未填狀態`]);
  });

  it('列出尚未填狀態的項數', () => {
    const annex = filled();
    annex.rows[0].status = null;
    annex.rows[3].status = null;
    expect(statusAnnexIssues(annex)).toEqual(['現況確認附件尚有 2 項未填狀態']);
  });

  it('有瑕疵的項目必須填備註', () => {
    const annex = filled();
    annex.rows[1] = { ...annex.rows[1], status: 'defect', note: '  ' };
    expect(statusAnnexIssues(annex)).toEqual([`現況確認附件「${annex.rows[1].label}」有瑕疵，請填備註說明`]);
  });

  it('全部填好且有瑕疵的項目有備註時沒有問題', () => {
    const annex = filled();
    annex.rows[1] = { ...annex.rows[1], status: 'defect', note: '浴室天花板有水漬' };
    annex.rows[2] = { ...annex.rows[2], status: 'not_applicable' };
    expect(statusAnnexIssues(annex)).toEqual([]);
  });
});

describe('statusAnnexInputError：存草稿時檢查形狀', () => {
  it('沒有帶或形狀正確時通過', () => {
    expect(statusAnnexInputError(undefined)).toBeNull();
    expect(statusAnnexInputError(defaultStatusAnnex())).toBeNull();
    expect(statusAnnexInputError(filled())).toBeNull();
  });

  it.each([
    ['不是物件', 'abc'],
    ['沒有版本', { rows: [] }],
    ['rows 不是陣列', { version: 1, rows: 'x' }],
    ['列缺識別字', { version: 1, rows: [{ label: 'a', status: null, note: '' }] }],
    ['狀態不在清單內', { version: 1, rows: [{ id: 'a', label: 'a', status: 'bad', note: '' }] }],
    ['備註不是字串', { version: 1, rows: [{ id: 'a', label: 'a', status: null, note: 5 }] }],
  ])('形狀不對：%s', (_name, value) => {
    expect(statusAnnexInputError(value)).not.toBeNull();
  });

  it('備註超過上限時擋下，附件才不會超出一頁', () => {
    const annex = defaultStatusAnnex();
    annex.rows[0].note = 'a'.repeat(STATUS_ANNEX_NOTE_MAX + 1);
    expect(statusAnnexInputError(annex)).toContain(`${STATUS_ANNEX_NOTE_MAX}`);
  });
});

describe('statusAnnexRequired：何時必附', () => {
  it('包租租賃合約必附，有經紀業者居間也必附', () => {
    expect(statusAnnexRequired(MASTER_LEASE, 'lease')).toBe(true);
    expect(statusAnnexRequired({ ...MASTER_LEASE, brokerMediated: true }, 'lease')).toBe(true);
  });

  it('自管、代管不附', () => {
    expect(statusAnnexRequired({ ...MASTER_LEASE, businessType: 'self_managed' }, 'lease')).toBe(false);
    expect(statusAnnexRequired({ ...MASTER_LEASE, businessType: 'managed' }, 'lease')).toBe(false);
  });

  it('屋主與包租業者的租賃合約（自管，承租人是包租業者）不附（ADR-0018 決議 8）', () => {
    const owner = { businessType: 'self_managed', lesseeIsMasterLessor: true, brokerMediated: false };
    expect(statusAnnexRequired(owner, 'lease')).toBe(false);
  });

  it('沒有分流條件的舊合約、規則未定義的組合、委託管理合約都不附', () => {
    expect(statusAnnexRequired(undefined, 'lease')).toBe(false);
    expect(statusAnnexRequired({ businessType: 'master_lease', lesseeIsMasterLessor: true, brokerMediated: false }, 'lease')).toBe(false);
    expect(statusAnnexRequired({ nonsense: true }, 'lease')).toBe(false);
    expect(statusAnnexRequired(MASTER_LEASE, 'management')).toBe(false);
  });
});

describe('statusAnnexOf：這份合約的 PDF 要不要印附件頁、印什麼', () => {
  it('草稿必附但還沒有內容時，印預設清單（全部未填）', () => {
    const annex = statusAnnexOf('draft', 'lease', { routing: MASTER_LEASE });
    expect(annex?.rows.every((r) => r.status === null)).toBe(true);
  });

  it('草稿印已存的內容', () => {
    const stored = filled();
    expect(statusAnnexOf('draft', 'lease', { routing: MASTER_LEASE, statusAnnex: stored })).toEqual(stored);
  });

  it('送簽後只印已凍結的內容，舊的包租合約沒有內容就不印（既有合約的 PDF 不變）', () => {
    expect(statusAnnexOf('awaiting_tenant', 'lease', { routing: MASTER_LEASE })).toBeNull();
    expect(statusAnnexOf('completed', 'lease', { routing: MASTER_LEASE })).toBeNull();
    const stored = filled();
    expect(statusAnnexOf('completed', 'lease', { routing: MASTER_LEASE, statusAnnex: stored })).toEqual(stored);
  });

  it('不必附的合約即使欄位裡留有內容也不印', () => {
    const fields = { routing: { ...MASTER_LEASE, businessType: 'self_managed' }, statusAnnex: filled() };
    expect(statusAnnexOf('draft', 'lease', fields)).toBeNull();
    expect(statusAnnexOf('draft', 'lease', {})).toBeNull();
  });
});

describe('statusAnnexSummary：詳情頁與確認頁的唯讀摘要', () => {
  it('每列一行：項目、狀態、備註', () => {
    const annex = filled();
    annex.rows[0] = { ...annex.rows[0], status: 'defect', note: '陽台滲水' };
    const lines = statusAnnexSummary(annex);
    expect(lines).toHaveLength(annex.rows.length);
    expect(lines[0]).toBe(`${annex.rows[0].label}：有瑕疵（陽台滲水）`);
    expect(lines[1]).toBe(`${annex.rows[1].label}：正常`);
  });

  it('尚未填的列標示未填', () => {
    expect(statusAnnexSummary(defaultStatusAnnex())[0]).toContain('未填');
  });
});
