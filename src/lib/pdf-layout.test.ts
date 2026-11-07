import { describe, expect, it } from 'vitest';
import { generateContractPdf } from './pdf';
import { signatureStampBaselines } from './pdf-layout';
import { bindTemplate } from './clause-library';
import type { ContractFields } from './types';

// signatureStampBaselines() 是把 generateContractPdf 的排版順序重走一遍推出來的，
// 這支測試拿真的產出 PDF 回頭核對，避免兩邊的版面邏輯偷偷長歪。

const fields: ContractFields = {
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

/** 從產出的 PDF 讀回兩個「簽章：」的頁碼與 baseline y。 */
async function readStampPositions(f: ContractFields = fields): Promise<{ page: number; y: number }[]> {
  const bytes = await generateContractPdf(f);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const found: { page: number; y: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    for (const item of content.items as { str: string; transform: number[] }[]) {
      if (item.str.startsWith('簽章：')) found.push({ page: i - 1, y: item.transform[5] });
    }
  }
  return found;
}

describe('signatureStampBaselines', () => {
  it('推出的 baseline 對得上實際產出的 PDF', async () => {
    const stamps = await readStampPositions();
    const expected = signatureStampBaselines();
    expect(stamps).toHaveLength(2);
    expect(stamps[0].y).toBeCloseTo(expected.party_a, 2);
    expect(stamps[1].y).toBeCloseTo(expected.party_b, 2);
  });

  // 簽署欄之後只剩設備附件頁（ADR-0008：附件排在本文與簽章之後）
  it('簽署欄自成一頁，兩個簽章欄在同一頁，其後只有設備附件頁', async () => {
    const bytes = await generateContractPdf(fields);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const numPages = (await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise).numPages;
    const stamps = await readStampPositions();
    expect(stamps[0].page).toBe(stamps[1].page);
    expect(stamps[0].page).toBe(numPages - 2);
  });

  it('沒有設備附件時簽署欄就是最後一頁', async () => {
    const stamps = await readStampPositions({ ...fields, equipmentAnnex: [] });
    const bytes = await generateContractPdf({ ...fields, equipmentAnnex: [] });
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const numPages = (await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise).numPages;
    expect(stamps[0].page).toBe(numPages - 1);
    expect(stamps[1].page).toBe(numPages - 1);
  });
});
