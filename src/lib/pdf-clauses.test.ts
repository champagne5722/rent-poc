import { describe, expect, it } from 'vitest';
import { generateContractPdf } from './pdf';
import { buildContractClauses, clauseNumeral, extraClauseLabel } from './contract-clauses';
import { OPTIONAL_CLAUSES, bindTemplate, findClause } from './clause-library';
import { signatureStampBaselines } from './pdf-layout';
import type { ContractFields } from './types';

// 選用條款併入 PDF 條款區（MIL-26、ADR-0005）：條號要連號、勾選條款要出現全文。

function fields(patch: Partial<ContractFields> = {}): ContractFields {
  return {
    propertyName: '測試物件',
    propertyAddress: '台北市中正區測試路 1 號',
    propertyType: '整層住家',
    propertySize: 25,
    equipment: ['冷氣'],
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

/** 把 PDF 的所有文字接成一串（每個 item 是一行，接起來即可比對被斷行的條文）。 */
async function pdfText(f: ContractFields): Promise<string> {
  const bytes = await generateContractPdf(f);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    text += (content.items as { str: string }[]).map((item) => item.str).join('');
  }
  return text;
}

describe('buildContractClauses', () => {
  it('沒勾選用條款時就是範本原本的九條', () => {
    const clauses = buildContractClauses(fields());
    expect(clauses).toHaveLength(9);
    expect(clauses[0].title).toBe('第一條　租賃標的');
    expect(clauses[7].title).toBe('第八條　其他約定事項');
    expect(clauses[8].title).toBe('第九條　契約份數與效力');
  });

  it('勾選的條款排在「其他約定事項」之前，條號連號往後推', () => {
    const clauses = buildContractClauses(fields(bindTemplate(['pet', 'utilities'])));
    expect(clauses).toHaveLength(11);
    expect(clauses.map((c) => c.title)).toEqual([
      '第一條　租賃標的',
      '第二條　租賃期間',
      '第三條　租金約定',
      '第四條　押金',
      '第五條　附屬設備',
      '第六條　使用約定',
      '第七條　契約終止與返還',
      '第八條　寵物飼養',
      '第九條　水電費分擔',
      '第十條　其他約定事項',
      '第十一條　契約份數與效力',
    ]);
  });

  it('條文用合約自己的快照，不回頭查平台條款庫', () => {
    const clauses = buildContractClauses(
      fields({ clauses: [{ id: 'pet', title: '寵物飼養', body: '（合約簽訂當時的舊版條文）', version: 1 }] })
    );
    expect(clauses[7]).toEqual({ title: '第八條　寵物飼養', body: '（合約簽訂當時的舊版條文）' });
  });
});

describe('clauseNumeral / extraClauseLabel', () => {
  it('條號的中文數字到十九都對', () => {
    expect([1, 7, 9, 10, 11, 14].map(clauseNumeral)).toEqual(['一', '七', '九', '十', '十一', '十四']);
  });

  it('「其他約定事項」的條號跟著勾選數量往後推', () => {
    expect(extraClauseLabel(bindTemplate())).toBe('第八條');
    expect(extraClauseLabel(bindTemplate(['pet', 'utilities']))).toBe('第十條');
    expect(extraClauseLabel(bindTemplate(OPTIONAL_CLAUSES.map((c) => c.id)))).toBe(
      `第${clauseNumeral(8 + OPTIONAL_CLAUSES.length)}條`
    );
  });
});

describe('generateContractPdf 併入選用條款', () => {
  it('勾選條款的全文出現在 PDF 條款區', async () => {
    const text = await pdfText(fields(bindTemplate(['early-exit'])));
    // 抽出的文字會把條號後的全形空白換成半形，比對時放寬空白
    expect(text).toMatch(/第八條\s*提前解約違約金/);
    expect(text).toContain(findClause('early-exit')!.body);
  }, 20000);

  it('沒勾的條款不會出現在 PDF', async () => {
    const text = await pdfText(fields(bindTemplate(['early-exit'])));
    expect(text).not.toContain('寵物飼養');
  }, 20000);

  it('勾滿條款也不影響簽名框的預設落點（簽署欄一律另起一頁）', async () => {
    const all = OPTIONAL_CLAUSES.map((c) => c.id);
    const bytes = await generateContractPdf(fields({ ...bindTemplate(all), extra: '補充事項。'.repeat(80) }));
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    const stamps: { page: number; y: number }[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      for (const item of content.items as { str: string; transform: number[] }[]) {
        if (item.str.startsWith('簽章：')) stamps.push({ page: i - 1, y: item.transform[5] });
      }
    }
    const expected = signatureStampBaselines();
    expect(stamps).toHaveLength(2);
    expect(stamps[0]).toEqual({ page: doc.numPages - 1, y: expect.closeTo(expected.landlord, 2) });
    expect(stamps[1]).toEqual({ page: doc.numPages - 1, y: expect.closeTo(expected.tenant, 2) });
    // 產 PDF＋讀回文字在冷啟動時偏慢，給寬一點的時限避免偶發超時
  }, 20000);
});
