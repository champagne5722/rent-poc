import { describe, expect, it } from 'vitest';
import { bindTemplate } from './clause-library';
import { contractPdfRenderer } from './contract-pdf';
import { signatureBlockLayout, statusAnnexSignTop, statusAnnexStampBaseline } from './pdf-layout';
import {
  STATUS_ANNEX_NOTE_MAX,
  STATUS_ANNEX_STATUS_LABELS,
  defaultStatusAnnex,
  type StatusAnnex,
} from './status-annex';
import type { ContractRoutingConditions, EquipmentAnnexRow, LeaseContractFields } from './types';

// 現況確認附件頁（MIL-71、ADR-0018 決議 6）：獨立一頁，排在簽署欄之後（有設備附件時在設備附件之後），
// 不動簽署欄的落點，執業人員簽署欄固定在頁底，備註再長也放得進一頁。

const MASTER_LEASE: ContractRoutingConditions = {
  businessType: 'master_lease',
  lesseeIsMasterLessor: false,
  brokerMediated: false,
};

const EQUIPMENT: EquipmentAnnexRow[] = [{ name: '冷氣', quantity: 2, repair: 'landlord', note: '' }];

const PRACTITIONER = {
  'lease.master_lease.practitioner': {
    name: '陳怡君',
    title: '租賃住宅管理人員',
    entityName: '北辰租賃住宅管理股份有限公司',
  },
};

function fields(patch: Partial<LeaseContractFields> = {}): LeaseContractFields {
  return {
    routing: MASTER_LEASE,
    propertyName: '測試物件',
    propertyAddress: '台北市中正區測試路 1 號',
    propertyType: '整層住家',
    propertySize: 25,
    equipmentAnnex: EQUIPMENT,
    landlordName: '北辰租賃住宅管理股份有限公司',
    landlordEmail: 'landlord@example.com',
    tenantName: '李小華',
    tenantEmail: 'tenant@example.com',
    rent: 25000,
    deposit: 50000,
    startDate: '2027-01-01',
    endDate: '2027-12-31',
    payDay: 5,
    extra: '',
    ...bindTemplate(),
    ...patch,
  };
}

function filled(overrides: Record<number, { status: 'normal' | 'defect' | 'not_applicable'; note?: string }> = {}): StatusAnnex {
  const annex = defaultStatusAnnex();
  return {
    ...annex,
    rows: annex.rows.map((r, i) => ({
      ...r,
      status: overrides[i]?.status ?? 'normal',
      note: overrides[i]?.note ?? '',
    })),
  };
}

interface TextItem {
  str: string;
  x: number;
  y: number;
}

interface Dump {
  pages: TextItem[][];
  text: string[];
  pageMap: { pageCount: number; signaturePage: number; statusAnnexPage: number | null };
}

async function render(
  f: LeaseContractFields,
  statusAnnex: StatusAnnex | null,
  practitioners: Record<string, { name: string; title?: string; entityName: string }> = PRACTITIONER,
): Promise<Dump> {
  const renderer = contractPdfRenderer('lease');
  if (!renderer) throw new Error('租賃合約應該有 PDF 產出函式');
  const { pdf, pages: pageMap } = await renderer.renderWithPages(f, practitioners, { statusAnnex });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf) }).promise;
  const pages: TextItem[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(
      (content.items as { str: string; transform: number[] }[]).map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
      })),
    );
  }
  return { pages, text: pages.map((p) => p.map((i) => i.str).join('')), pageMap };
}

describe('頁序', () => {
  it('本文、簽署欄、設備附件、現況確認附件', async () => {
    const d = await render(fields(), filled());
    const titles = d.text.map((t) => ({
      signature: t.includes('立契約書人'),
      equipment: t.includes('附屬設備清單'),
      status: t.includes('現況確認附件'),
    }));
    const last = d.pages.length - 1;
    expect(titles[last - 2].signature).toBe(true);
    expect(titles[last - 1].equipment).toBe(true);
    expect(titles[last].status).toBe(true);
    expect(d.pageMap).toEqual({ pageCount: d.pages.length, signaturePage: last - 2, statusAnnexPage: last });
  });

  it('沒有設備附件時，現況確認附件緊接在簽署欄之後', async () => {
    const d = await render(fields({ equipmentAnnex: [] }), filled());
    const last = d.pages.length - 1;
    expect(d.text[last - 1]).toContain('立契約書人');
    expect(d.text[last]).toContain('現況確認附件');
    expect(d.pageMap.statusAnnexPage).toBe(last);
    expect(d.pageMap.signaturePage).toBe(last - 1);
  });

  it('沒有現況確認附件時頁數與頁序不變，頁面地圖沒有附件頁', async () => {
    const withAnnex = await render(fields(), filled());
    const without = await render(fields(), null);
    expect(without.pages.length).toBe(withAnnex.pages.length - 1);
    expect(without.text.every((t) => !t.includes('現況確認附件'))).toBe(true);
    expect(without.pageMap.statusAnnexPage).toBeNull();
    expect(without.pageMap.signaturePage).toBe(withAnnex.pageMap.signaturePage);
  });
});

describe('附件頁的文字', () => {
  it('標題用「現況確認附件」，法定文件名是「現況確認書」，列出每一項的狀態與備註', async () => {
    const annex = filled({ 1: { status: 'defect', note: '浴室天花板有水漬' }, 2: { status: 'not_applicable' } });
    const d = await render(fields(), annex);
    const page = d.text[d.pageMap.statusAnnexPage!];
    // pdf.js 把全形空白讀成半形空白，比對時去掉空白
    expect(page.replace(/\s/g, '')).toContain('附件現況確認附件');
    expect(page).toContain('現況確認書');
    for (const row of annex.rows) expect(page).toContain(row.label.replace(/\s/g, ''));
    expect(page).toContain(STATUS_ANNEX_STATUS_LABELS.defect);
    expect(page).toContain(STATUS_ANNEX_STATUS_LABELS.not_applicable);
    expect(page).toContain('浴室天花板有水漬');
  });

  it('尚未填的列印「未填」，預覽草稿時看得出缺什麼', async () => {
    const d = await render(fields(), defaultStatusAnnex());
    expect(d.text[d.pageMap.statusAnnexPage!]).toContain('未填');
  });

  it('頁底印執業人員的姓名、法定稱謂與執業主體，不印證號', async () => {
    const d = await render(fields(), filled());
    const page = d.text[d.pageMap.statusAnnexPage!];
    expect(page).toContain('執業人員：陳怡君（租賃住宅管理人員）');
    expect(page).toContain('執業主體：北辰租賃住宅管理股份有限公司');
    expect(page).toContain('簽章：');
  });

  it('尚未指派執業人員時留底線', async () => {
    const d = await render(fields(), filled(), {});
    expect(d.text[d.pageMap.statusAnnexPage!]).toContain('執業人員：＿＿＿＿＿＿');
  });
});

describe('不影響簽署欄落點', () => {
  it('簽署欄「簽章：」的位置與沒有現況確認附件時完全相同', async () => {
    const stamps = (d: Dump) =>
      d.pages[d.pageMap.signaturePage].filter((i) => i.str.startsWith('簽章：')).map((i) => i.y);
    const withAnnex = await render(fields(), filled());
    const without = await render(fields(), null);
    expect(stamps(withAnnex)).toEqual(stamps(without));
    const expected = signatureBlockLayout([
      { role: 'party_b', slot: 'lease.master_lease.party_b' },
      { role: 'practitioner', slot: 'lease.master_lease.practitioner' },
      { role: 'party_a', slot: 'lease.master_lease.party_a' },
    ]).map((s) => s.stampBaseline);
    expect(stamps(withAnnex).sort((a, b) => b - a)).toEqual(expected.sort((a, b) => b - a));
  });
});

describe('附件一定是獨立的一頁', () => {
  it('備註寫到上限、每一項都有瑕疵時仍是一頁，表格不會壓到簽署欄', async () => {
    const longNote = '寬'.repeat(STATUS_ANNEX_NOTE_MAX);
    const overrides = Object.fromEntries(defaultStatusAnnex().rows.map((_, i) => [i, { status: 'defect' as const, note: longNote }]));
    const d = await render(fields(), filled(overrides));
    expect(d.pageMap.statusAnnexPage).toBe(d.pages.length - 1);
    const annexPage = d.pages[d.pageMap.statusAnnexPage!];
    const tableItems = annexPage.filter((i) => i.str.includes('寬') || i.str.includes('有瑕疵'));
    expect(tableItems.length).toBeGreaterThan(0);
    // 表格文字的 baseline 必須高於簽署欄的頂端（PDF 座標，y 向上）
    expect(Math.min(...tableItems.map((i) => i.y))).toBeGreaterThan(statusAnnexSignTop());
  });

  it('簽署欄固定在頁底，不隨表格長短移動', async () => {
    const short = await render(fields(), filled());
    const overrides = Object.fromEntries(defaultStatusAnnex().rows.map((_, i) => [i, { status: 'defect' as const, note: '寬'.repeat(STATUS_ANNEX_NOTE_MAX) }]));
    const long = await render(fields(), filled(overrides));
    const stampY = (d: Dump) => d.pages[d.pageMap.statusAnnexPage!].find((i) => i.str.startsWith('簽章：'))!.y;
    expect(stampY(short)).toBeCloseTo(statusAnnexStampBaseline(), 1);
    expect(stampY(long)).toBeCloseTo(statusAnnexStampBaseline(), 1);
  });
});
