import { describe, expect, it } from 'vitest';
import { generateContractPdf } from './pdf';
import { signatureStampBaselines } from './pdf-layout';
import { bindTemplate } from './clause-library';
import type { ContractFields, EquipmentAnnexRow } from './types';

// 設備附件頁（MIL-29、ADR-0008）：另起一頁排在簽署欄之後，欄位為項目／數量／修繕責任／備註。
// 沒有設備附件列就不產這一頁；有沒有附件頁都不得動到簽名框的預設落點。

const ANNEX: EquipmentAnnexRow[] = [
  { name: '冷氣', quantity: 2, repair: 'landlord', note: '客廳與主臥各一台' },
  { name: '洗衣機', quantity: 1, repair: 'tenant', note: '' },
];

function fields(patch: Partial<ContractFields> = {}): ContractFields {
  return {
    propertyName: '測試物件',
    propertyAddress: '台北市中正區測試路 1 號',
    propertyType: '整層住家',
    propertySize: 25,
    equipmentAnnex: ANNEX,
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
    ...patch,
  };
}

interface PdfDump {
  pages: string[];
  stamps: { page: number; y: number }[];
}

/** 產 PDF 後讀回每頁文字與兩個「簽章：」的位置。 */
async function dump(f: ContractFields): Promise<PdfDump> {
  const bytes = await generateContractPdf(f);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages: string[] = [];
  const stamps: { page: number; y: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    const items = content.items as { str: string; transform: number[] }[];
    pages.push(items.map((item) => item.str).join(''));
    for (const item of items) {
      if (item.str.startsWith('簽章：')) stamps.push({ page: i - 1, y: item.transform[5] });
    }
  }
  return { pages, stamps };
}

describe('設備附件頁', () => {
  it('另起一頁排在簽署欄頁之後，是 PDF 的最後一頁', async () => {
    const { pages, stamps } = await dump(fields());
    const annexPage = pages.length - 1;
    expect(pages[annexPage]).toContain('附屬設備清單');
    expect(stamps[0].page).toBe(annexPage - 1);
    expect(stamps[1].page).toBe(annexPage - 1);
  }, 20000);

  it('表格有四個欄位，每列印出項目、數量、修繕責任與備註', async () => {
    const { pages } = await dump(fields());
    const annex = pages[pages.length - 1];
    for (const header of ['項目', '數量', '修繕責任', '備註']) expect(annex).toContain(header);
    expect(annex).toContain('冷氣');
    expect(annex).toContain('客廳與主臥各一台');
    expect(annex).toContain('洗衣機');
    // 修繕責任印中文標籤而非 landlord／tenant
    expect(annex).toContain('出租人');
    expect(annex).toContain('承租人');
    expect(annex).not.toContain('landlord');
  }, 20000);

  it('沒有設備附件列時不產附件頁，最後一頁仍是簽署欄', async () => {
    const { pages, stamps } = await dump(fields({ equipmentAnnex: [] }));
    expect(pages.join('')).not.toContain('附屬設備清單');
    expect(stamps[0].page).toBe(pages.length - 1);
  }, 20000);

  // v1 與 v2 並存（ADR-0008）：v1 合約的設備仍列在本文，沒有附件頁
  it('範本 v1 的合約不產附件頁', async () => {
    const { pages, stamps } = await dump(
      fields({ templateVersion: 1, equipmentAnnex: undefined, equipment: ['冷氣 ×2', '洗衣機'] })
    );
    expect(pages.join('')).not.toContain('附屬設備清單');
    expect(pages.join('')).toContain('本房屋現有附屬設備如下');
    expect(stamps[0].page).toBe(pages.length - 1);
  }, 20000);

  // 升版重建後才有附件頁；此時舊欄位已被轉成附件列，即使沒轉乾淨也讀得到
  it('v2 合約即使只剩舊欄位資料也產得出附件頁', async () => {
    const { pages } = await dump(fields({ equipmentAnnex: undefined, equipment: ['冷氣 ×2', '洗衣機'] }));
    const annex = pages[pages.length - 1];
    expect(annex).toContain('附屬設備清單');
    expect(annex).toContain('冷氣');
    expect(annex).toContain('出租人');
  }, 20000);

  it('附件頁不影響簽名框的預設落點', async () => {
    const expected = signatureStampBaselines();
    const withAnnex = await dump(fields());
    const withoutAnnex = await dump(fields({ equipmentAnnex: [] }));
    for (const { stamps } of [withAnnex, withoutAnnex]) {
      expect(stamps).toHaveLength(2);
      expect(stamps[0].y).toBeCloseTo(expected.party_a, 2);
      expect(stamps[1].y).toBeCloseTo(expected.party_b, 2);
      expect(stamps[0].page).toBe(stamps[1].page);
    }
    // 附件列再多也一樣：表格滿到換頁都不會回頭推擠簽署欄
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `設備 ${i + 1}`,
      quantity: i + 1,
      repair: 'tenant' as const,
      note: '備註文字'.repeat(6),
    }));
    const bulky = await dump(fields({ equipmentAnnex: many }));
    expect(bulky.stamps[0].y).toBeCloseTo(expected.party_a, 2);
    expect(bulky.stamps[1].y).toBeCloseTo(expected.party_b, 2);
    expect(bulky.stamps[0].page).toBe(bulky.stamps[1].page);
  }, 30000);
});
