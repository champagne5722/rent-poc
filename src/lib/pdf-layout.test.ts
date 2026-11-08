import { describe, expect, it } from 'vitest';
import { generateContractPdf } from './pdf';
import { signatureBlockLayout, signatureStampBaselines } from './pdf-layout';
import { bindTemplate } from './clause-library';
import type { LeaseContractFields } from './types';

// signatureStampBaselines() 是把 generateContractPdf 的排版順序重走一遍推出來的，
// 這支測試拿真的產出 PDF 回頭核對，避免兩邊的版面邏輯偷偷長歪。

const fields: LeaseContractFields = {
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
async function readStampPositions(f: LeaseContractFields = fields): Promise<{ page: number; y: number }[]> {
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

describe('signatureBlockLayout（簽署欄版面：席位進、落點出）', () => {
  it('兩方合約的落點不變：甲方 696.89、乙方 594.89', () => {
    const spots = signatureBlockLayout([{ role: 'party_a' }, { role: 'party_b' }]);
    expect(spots.map((s) => s.role)).toEqual(['party_a', 'party_b']);
    expect(spots[0].stampBaseline).toBeCloseTo(696.89, 2);
    expect(spots[1].stampBaseline).toBeCloseTo(594.89, 2);
  });

  it('輸入順序是簽署順序，印列順序固定為甲方、乙方、執業人員', () => {
    const spots = signatureBlockLayout([
      { role: 'party_b', slot: 'b' },
      { role: 'practitioner', slot: 'p' },
      { role: 'party_a', slot: 'a' },
    ]);
    expect(spots.map((s) => s.slot)).toEqual(['a', 'b', 'p']);
    expect(spots.map((s) => s.stampBaseline.toFixed(2))).toEqual(['696.89', '594.89', '492.89']);
  });

  it('不論輸入順序，同一份席位印出的落點相同', () => {
    const forward = signatureBlockLayout([{ role: 'party_a' }, { role: 'practitioner' }, { role: 'party_b' }]);
    const reversed = signatureBlockLayout([{ role: 'party_b' }, { role: 'practitioner' }, { role: 'party_a' }]);
    expect(forward.map((s) => [s.role, s.stampBaseline])).toEqual(reversed.map((s) => [s.role, s.stampBaseline]));
  });

  it('同一角色有兩個席位時保留序列內的先後（管理人員在前、經紀人在後）', () => {
    const spots = signatureBlockLayout([
      { role: 'party_b', slot: 'b' },
      { role: 'practitioner', slot: 'manager' },
      { role: 'party_a', slot: 'a' },
      { role: 'practitioner', slot: 'broker' },
    ]);
    expect(spots.map((s) => s.slot)).toEqual(['a', 'b', 'manager', 'broker']);
    expect(spots[3].stampBaseline).toBeCloseTo(390.89, 2);
  });

  it('signatureStampBaselines 仍是兩方落點', () => {
    expect(signatureStampBaselines().party_a).toBeCloseTo(696.89, 2);
    expect(signatureStampBaselines().party_b).toBeCloseTo(594.89, 2);
  });
});
