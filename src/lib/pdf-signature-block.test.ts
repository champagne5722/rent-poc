import { describe, expect, it } from 'vitest';
import { bindTemplate } from './clause-library';
import { generateContractPdf } from './pdf';
import { signatureBlockLayout } from './pdf-layout';
import goldenTwoParty from './pdf-two-party.golden.json';
import type { LeaseContractFields, ContractRoutingConditions } from './types';

// 簽署欄依簽署序列印 N 列（ADR-0018 決議 14）。
// goldenTwoParty 是改動前在 main 上以同一份欄位產出的 PDF 逐字位置，用來證明兩方合約的 PDF 不動（ADR-0006）。

const baseFields: LeaseContractFields = {
  propertyName: '測試物件',
  propertyAddress: '台北市中正區測試路 1 號',
  propertyType: '整層住家',
  propertySize: 25,
  equipmentAnnex: [
    { name: '冷氣', quantity: 2, repair: 'landlord', note: '' },
    { name: '洗衣機', quantity: 1, repair: 'tenant', note: '' },
  ],
  landlordName: '王大明',
  landlordEmail: 'landlord@example.com',
  tenantName: '李小華',
  tenantEmail: 'tenant@example.com',
  rent: 25000,
  deposit: 50000,
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  payDay: 5,
  extra: '',
  ...bindTemplate(),
};

const withRouting = (routing: ContractRoutingConditions): LeaseContractFields => ({ ...baseFields, routing });
const MASTER_LEASE = withRouting({ businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false });
const MASTER_LEASE_BROKER = withRouting({
  businessType: 'master_lease',
  lesseeIsMasterLessor: false,
  brokerMediated: true,
});

interface TextItem {
  str: string;
  x: number;
  y: number;
}

async function readPages(
  f: LeaseContractFields,
  practitioners: Parameters<typeof generateContractPdf>[1] = {}
): Promise<TextItem[][]> {
  const bytes = await generateContractPdf(f, practitioners);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages: TextItem[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(
      (content.items as { str: string; transform: number[] }[])
        .filter((item) => item.str !== '')
        .map((item) => ({
          str: item.str,
          x: Math.round(item.transform[4] * 100) / 100,
          y: Math.round(item.transform[5] * 100) / 100,
        })),
    );
  }
  return pages;
}

/** 簽署欄所在頁：有「立契約書人」的那一頁。 */
async function signaturePage(
  f: LeaseContractFields,
  practitioners: Parameters<typeof generateContractPdf>[1] = {}
): Promise<TextItem[]> {
  const page = (await readPages(f, practitioners)).find((items) => items.some((item) => item.str === '立契約書人'));
  if (!page) throw new Error('找不到簽署欄');
  return page;
}

/** 簽署欄各列標題的稱謂，依印出的先後。 */
function headingsOf(items: TextItem[]): string[] {
  return items.flatMap((item) => {
    const match = item.str.match(/^(甲方|乙方|執業人員)/);
    return match ? [match[1]] : [];
  });
}

describe('兩方合約的 PDF 不變（ADR-0006）', () => {
  it('沒有分流條件的合約，逐字位置與改動前一致', async () => {
    expect(await readPages(baseFields)).toEqual(goldenTwoParty);
  });

  it('明確填了自管分流條件，與沒有分流條件的 PDF 相同', async () => {
    const explicit = withRouting({ businessType: 'self_managed', lesseeIsMasterLessor: false, brokerMediated: false });
    expect(await readPages(explicit)).toEqual(goldenTwoParty);
  });

  it('代管的租賃合約仍是兩方，PDF 相同', async () => {
    const managed = withRouting({ businessType: 'managed', lesseeIsMasterLessor: false, brokerMediated: false });
    expect(await readPages(managed)).toEqual(goldenTwoParty);
  });

  it('規則未定義的分流條件不讓 PDF 預覽壞掉，退回兩方版面', async () => {
    const undefinedCombo = withRouting({ businessType: 'managed', lesseeIsMasterLessor: true, brokerMediated: false });
    expect(await readPages(undefinedCombo)).toEqual(goldenTwoParty);
  });
});

describe('簽署欄依簽署序列印 N 列', () => {
  it('包租：印列順序是甲方、乙方、執業人員，落點對得上版面函式', async () => {
    const items = await signaturePage(MASTER_LEASE);
    const stamps = items.filter((item) => item.str.startsWith('簽章：')).map((item) => item.y);
    const expected = signatureBlockLayout([
      { role: 'party_b' },
      { role: 'practitioner' },
      { role: 'party_a' },
    ]).map((spot) => spot.stampBaseline);
    expect(stamps).toHaveLength(3);
    stamps.forEach((y, i) => expect(y).toBeCloseTo(expected[i], 2));

    expect(headingsOf(items)).toEqual(['甲方', '乙方', '執業人員']);
  });

  it('甲方與乙方的落點與兩方合約相同，執業人員接在乙方之後', async () => {
    const items = await signaturePage(MASTER_LEASE);
    const stamps = items.filter((item) => item.str.startsWith('簽章：')).map((item) => item.y);
    expect(stamps[0]).toBeCloseTo(696.89, 2);
    expect(stamps[1]).toBeCloseTo(594.89, 2);
    expect(stamps[2]).toBeCloseTo(492.89, 2);
  });

  it('尚未指派的執業人員留底線，印法定稱謂，不印證號與 Email', async () => {
    const items = await signaturePage(MASTER_LEASE);
    const texts = items.map((item) => item.str);
    expect(texts).toContain('執業人員：＿＿＿＿＿＿（租賃住宅管理人員）');
    expect(texts).toContain('執業主體：＿＿＿＿＿＿');
    expect(texts.filter((t) => t.startsWith('Email：'))).toHaveLength(2);
    expect(texts.some((t) => t.includes('證號'))).toBe(false);
  });

  it('包租加經紀業者居間：第四列是不動產經紀人，簽署欄仍在同一頁', async () => {
    const items = await signaturePage(MASTER_LEASE_BROKER);
    const texts = items.map((item) => item.str);
    expect(texts.filter((t) => t.startsWith('簽章：'))).toHaveLength(4);
    expect(texts.indexOf('執業人員：＿＿＿＿＿＿（租賃住宅管理人員）')).toBeLessThan(
      texts.indexOf('執業人員：＿＿＿＿＿＿（不動產經紀人）'),
    );
    const lastStamp = items.filter((item) => item.str.startsWith('簽章：')).at(-1)!;
    expect(lastStamp.y).toBeCloseTo(390.89, 2);
  });

  it('自管且承租人是包租業者：執業人員同樣印在乙方之後', async () => {
    const items = await signaturePage(
      withRouting({ businessType: 'self_managed', lesseeIsMasterLessor: true, brokerMediated: false }),
    );
    expect(headingsOf(items)).toEqual(['甲方', '乙方', '執業人員']);
  });

  describe('已指派的執業人員（MIL-69）', () => {
    const printed = {
      'lease.master_lease.practitioner': {
        name: '陳怡君',
        title: '租賃住宅管理人員',
        entityName: '北辰租賃住宅管理股份有限公司',
      },
    };

    it('印姓名、法定稱謂與執業主體，不印證號', async () => {
      const texts = (await signaturePage(MASTER_LEASE, printed)).map((item) => item.str);
      expect(texts).toContain('執業人員：陳怡君（租賃住宅管理人員）');
      expect(texts).toContain('執業主體：北辰租賃住宅管理股份有限公司');
      expect(texts.some((t) => t.includes('證號') || t.includes('證書'))).toBe(false);
    });

    it('只指派了其中一個席位時，另一個席位仍留底線', async () => {
      const texts = (await signaturePage(MASTER_LEASE_BROKER, printed)).map((item) => item.str);
      expect(texts).toContain('執業人員：陳怡君（租賃住宅管理人員）');
      expect(texts).toContain('執業人員：＿＿＿＿＿＿（不動產經紀人）');
    });

    it('有姓名時簽署欄的落點與留底線時相同', async () => {
      const filled = await signaturePage(MASTER_LEASE, printed);
      const blank = await signaturePage(MASTER_LEASE);
      const stamps = (items: TextItem[]) => items.filter((item) => item.str.startsWith('簽章：')).map((item) => item.y);
      expect(stamps(filled)).toEqual(stamps(blank));
    });
  });
});
