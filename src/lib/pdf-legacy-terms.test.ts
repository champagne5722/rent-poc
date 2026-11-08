import { describe, expect, it } from 'vitest';
import { bindTemplate } from './clause-library';
import { LEGACY_TERMS } from './labels';
import { generateContractPdf } from './pdf';
import type { ContractFields, ContractRoutingConditions } from './types';

// 合約 PDF 的全文不含舊用詞，也不出現「經理人」（MIL-122 AC，P0-01 AC6）。
// 從真的產出的 PDF 讀回全文檢查，不看原始碼。

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

const masterLease: ContractRoutingConditions = {
  businessType: 'master_lease',
  lesseeIsMasterLessor: false,
  brokerMediated: true,
};

async function pdfText(
  f: ContractFields,
  practitioners: Parameters<typeof generateContractPdf>[1] = {}
): Promise<string> {
  const bytes = await generateContractPdf(f, practitioners);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    parts.push((content.items as { str: string }[]).map((item) => item.str).join(''));
  }
  return parts.join('\n');
}

/** 把「執業主體」這個合法詞拿掉，避免「業主」子字串誤判。 */
function withoutExemptPhrases(text: string): string {
  return LEGACY_TERMS.exemptPhrases.reduce((acc, phrase) => acc.split(phrase).join(''), text);
}

const banned = [...LEGACY_TERMS.everywhere, ...LEGACY_TERMS.contractPdfAndLessee];

describe('合約 PDF 不含舊用詞', () => {
  const cases: [string, ContractFields, Parameters<typeof generateContractPdf>[1]][] = [
    ['兩方合約', fields, {}],
    [
      '包租加經紀業者居間，執業人員已指派',
      { ...fields, routing: masterLease },
      {
        'lease.master_lease.practitioner': {
          name: '陳怡君',
          title: '租賃住宅管理人員',
          entityName: '北辰租賃住宅管理股份有限公司',
        },
      },
    ],
  ];

  it.each(cases)('%s', async (_name, f, practitioners) => {
    const text = withoutExemptPhrases(await pdfText(f, practitioners));
    for (const term of banned) expect(text).not.toContain(term);
  }, 30000);

  it('簽署欄與開頭印出租人、承租人，附件的修繕責任也是出租人、承租人', async () => {
    const text = await pdfText(fields);
    expect(text).toContain('甲方（出租人）');
    expect(text).toContain('乙方（承租人）');
    expect(text).toContain('出租人：王大明（以下簡稱甲方）');
    expect(text).toContain('冷氣 2 出租人');
    expect(text).toContain('洗衣機 1 承租人');
  }, 30000);
});
