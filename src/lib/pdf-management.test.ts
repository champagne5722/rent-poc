import { describe, expect, it } from 'vitest';
import { signatureBlockLayout } from './pdf-layout';
import { contractPdfRenderer } from './contract-pdf';
import type { MandateItem } from './mandate-schedule';
import type { ManagementContractFields } from './types';

// 委託管理契約書的 PDF（MIL-74、P0-11）：標題、條文、簽署欄、附件頁的文字與順序。

const FIELDS: ManagementContractFields = {
  mandatorName: '陳屋主',
  mandatorEmail: 'owner@example.com',
  mandataryName: '王建國',
  mandataryEmail: 'wang@beichen.example.com',
  termStart: '2027-01-01',
  termEnd: '2027-12-31',
  feeMode: 'monthly_fixed',
  feeValue: 3000,
  extra: '',
  templateId: 'management-agreement',
  templateVersion: 1,
  clauses: [],
};

const ITEMS: MandateItem[] = [
  { propertyId: '7', propertyName: '信義小宅', propertyAddress: '台北市信義區松仁路 1 號', scopes: ['rent_collection', 'repair'] },
  { propertyId: '9', propertyName: '大安套房', propertyAddress: '台北市大安區和平東路 2 號', scopes: ['deposit_management', 'handover'] },
];

const PRACTITIONER = {
  'management.managed.practitioner': {
    name: '陳怡君',
    title: '租賃住宅管理人員',
    entityName: '北辰租賃住宅管理股份有限公司',
  },
};

interface TextItem {
  str: string;
  x: number;
  y: number;
}

async function render(
  fields: ManagementContractFields = FIELDS,
  items: readonly MandateItem[] = ITEMS,
  practitioners: Record<string, { name: string; title?: string; entityName: string }> = PRACTITIONER,
): Promise<TextItem[][]> {
  const renderer = contractPdfRenderer('management');
  if (!renderer) throw new Error('委託管理合約應該有 PDF 產出函式');
  const bytes = await renderer.render(fields, practitioners, { mandateItems: items });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
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
  return pages;
}

// pdfjs 把全形空白讀成半形，比對前一律去掉空白
const squash = (text: string) => text.replace(/\s/g, '');
const textOf = (page: TextItem[]) => squash(page.map((i) => i.str).join(''));

describe('委託管理契約書 PDF', () => {
  it('標題用法定文件名「委託管理契約書」，開頭列出甲方與乙方', async () => {
    const pages = await render();
    const first = textOf(pages[0]);
    expect(first).toContain(squash('委託管理契約書'));
    expect(first).not.toContain(squash('房屋租賃契約書'));
    expect(first).toContain(squash('委託人：陳屋主（以下簡稱甲方）'));
    expect(first).toContain(squash('受託人：北辰租賃住宅管理股份有限公司（以下簡稱乙方）'));
  });

  it('條文印委託期間與報酬約定', async () => {
    const first = textOf((await render())[0]);
    expect(first).toContain(squash('第一條　委託標的'));
    expect(first).toContain(squash('自 2027 年 01 月 01 日起至 2027 年 12 月 31 日止'));
    expect(first).toContain(squash('每月固定新臺幣 3,000 元整'));
  });

  it('頁序是條文、簽署欄、附件，附件排在簽署欄之後', async () => {
    const pages = await render();
    expect(pages).toHaveLength(3);
    expect(textOf(pages[1])).toContain(squash('立契約書人'));
    expect(textOf(pages[1])).not.toContain(squash('委託標的清單'));
    expect(textOf(pages[2])).toContain(squash('附件　委託標的清單'));
  });

  it('簽署欄印甲方（委託人）、乙方（受託人）與執業人員，不印證號', async () => {
    const sign = textOf((await render())[1]);
    expect(sign).toContain(squash('甲方（委託人）：陳屋主'));
    expect(sign).toContain(squash('Email：owner@example.com'));
    expect(sign).toContain(squash('乙方（受託人）：王建國'));
    expect(sign).toContain(squash('Email：wang@beichen.example.com'));
    expect(sign).toContain(squash('執業人員：陳怡君（租賃住宅管理人員）'));
    expect(sign).toContain(squash('執業主體：北辰租賃住宅管理股份有限公司'));
    expect(sign).not.toMatch(/RHM|證號/);
  });

  it('簽署欄印列順序是甲方、乙方、執業人員，落點與共用版面一致', async () => {
    const page = (await render())[1];
    const stamps = page.filter((i) => i.str.startsWith('簽章：')).map((i) => i.y);
    const expected = signatureBlockLayout([
      { role: 'party_a' },
      { role: 'party_b' },
      { role: 'practitioner' },
    ]).map((spot) => spot.stampBaseline);
    expect(stamps).toHaveLength(3);
    stamps.forEach((y, i) => expect(Math.abs(y - expected[i])).toBeLessThan(1));
    const text = textOf(page);
    expect(text.indexOf('甲方（委託人）')).toBeLessThan(text.indexOf('乙方（受託人）'));
    expect(text.indexOf('乙方（受託人）')).toBeLessThan(text.indexOf('執業人員：'));
  });

  it('尚未指派執業人員時，姓名與執業主體留底線', async () => {
    const pages = await render(FIELDS, ITEMS, {});
    const sign = textOf(pages[1]);
    expect(sign).toContain(squash('執業人員：＿＿＿＿＿＿（租賃住宅管理人員）'));
    expect(sign).toContain(squash('執業主體：＿＿＿＿＿＿'));
    expect(textOf(pages[0])).toContain(squash('受託人：王建國（以下簡稱乙方）'));
  });

  it('附件頁列出每個租賃單位的名稱、地址與委託範圍', async () => {
    const annex = textOf((await render())[2]);
    expect(annex).toContain(squash('委託範圍之項目包括收租、押金管理、修繕、點交'));
    expect(annex).toContain(squash('租賃單位'));
    expect(annex).toContain(squash('信義小宅'));
    expect(annex).toContain(squash('台北市信義區松仁路 1 號'));
    expect(annex).toContain(squash('收租、修繕'));
    expect(annex).toContain(squash('大安套房'));
    expect(annex).toContain(squash('台北市大安區和平東路 2 號'));
    expect(annex).toContain(squash('押金管理、點交'));
  });

  it('沒有清單列時不產附件頁', async () => {
    const pages = await render(FIELDS, []);
    expect(pages).toHaveLength(2);
  });

  it('清單列多到一頁放不下時續頁，每頁重畫表頭', async () => {
    const many: MandateItem[] = Array.from({ length: 40 }, (_, i) => ({
      propertyId: String(i),
      propertyName: `租賃單位${i + 1}`,
      propertyAddress: `台北市測試路 ${i + 1} 號`,
      scopes: ['rent_collection', 'deposit_management', 'repair', 'handover'],
    }));
    const pages = await render(FIELDS, many);
    expect(pages.length).toBeGreaterThan(3);
    for (const page of pages.slice(2)) expect(textOf(page)).toContain(squash('委託範圍'));
  });
});
