import { describe, expect, it } from 'vitest';
import { bindTemplate } from './clause-library';
import { contractPdfRenderer } from './contract-pdf';
import { generateContractPdf, PDF_PAGE_SIZE } from './pdf';
import type { LeaseContractFields } from './types';

// 依合約類型產出 PDF（MIL-73）：租賃合約的產出與直接呼叫租賃的產生函式相同，
// 沒有 PDF 的合約類型（委託管理合約在 MIL-74 之前）回 null，送簽流程據此擋下。

const LEASE_FIELDS: LeaseContractFields = {
  landlordName: '王大明',
  landlordEmail: 'landlord@example.com',
  tenantName: '李小華',
  tenantEmail: 'tenant@example.com',
  propertyName: '測試物件',
  propertyAddress: '台北市中正區測試路 1 號',
  propertyType: '整層住家',
  propertySize: 25,
  equipmentAnnex: [{ name: '冷氣', quantity: 1, repair: 'landlord', note: '' }],
  rent: 25000,
  deposit: 50000,
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  payDay: 5,
  extra: '',
  ...bindTemplate(),
};

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push((content.items as { str: string }[]).map((item) => item.str).join(''));
  }
  return pages;
}

describe('contractPdfRenderer', () => {
  it('租賃合約：頁面尺寸與租賃 PDF 相同，內容逐頁相同', async () => {
    const renderer = contractPdfRenderer('lease');
    expect(renderer?.pageSize).toEqual(PDF_PAGE_SIZE);
    const viaRegistry = await renderer!.render(LEASE_FIELDS, {});
    const direct = await generateContractPdf(LEASE_FIELDS, {});
    expect(await pageTexts(viaRegistry)).toEqual(await pageTexts(direct));
  }, 60_000);

  it('委託管理合約有 PDF 產出函式，頁面尺寸與租賃 PDF 相同（內容見 pdf-management.test.ts）', () => {
    expect(contractPdfRenderer('management')?.pageSize).toEqual(PDF_PAGE_SIZE);
  });
});
