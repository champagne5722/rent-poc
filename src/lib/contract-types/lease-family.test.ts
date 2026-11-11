import { describe, expect, it } from 'vitest';
import { LEGACY_TERMS, partyLabels } from '../labels';
import { contractPdfRenderer } from '../contract-pdf';
import { SUBLEASE_TEMPLATE, MASTER_LEASE_TEMPLATE } from '../clause-library';
import { evaluateRouting } from '../signature-routing';
import { SIGNATURE_RULES_VERSION } from '../signature-routing';
import { defaultStatusAnnex, statusAnnexOf, statusAnnexRequired } from '../status-annex';
import { boundTemplateOf, currentTemplate, isLegalReviewed } from '../template-registry';
import { templateReviewBlock, TEMPLATE_NOT_REVIEWED_CODE } from '../template-review';
import type {
  ContractRoutingConditions,
  LeaseContractFields,
  MasterLeaseContractFields,
  Property,
  SubleaseContractFields,
} from '../types';
import {
  caseKindForContractType,
  contractTypeDefinition,
  contractTypeForCaseKind,
  initialFieldsFor,
  listSummaryOf,
  missingFieldsOf,
  partyOf,
  routingSnapshotFor,
  withParty,
} from './index';
import type { ContractType } from '../labels';
import { STATUTORY_CASE_KINDS } from '../cases';

// 包租合約與轉租合約的類型定義（MIL-199、ADR-0030 決議 6、7）。

const PROPERTY: Property = {
  id: '01HZ0000000000000000000007',
  rental_unit_id: '01HZ0000000000000000000008',
  unit: null,
  archived_at: null,
  anchor: null,
  verification_status: 'verified',
  name: '信義小宅',
  address: '台北市信義區松仁路 1 號',
  type: '套房',
  size: 12.5,
  default_rent: 18000,
  note: '',
  equipment: [
    { name: '冷氣', quantity: 2 },
    { name: '冰箱', quantity: 1 },
  ],
  created_at: '2026-01-01 00:00:00',
  updated_at: null,
};

function filled<T extends MasterLeaseContractFields | SubleaseContractFields>(type: 'master_lease' | 'sublease'): T {
  const fields = initialFieldsFor(type, { property: PROPERTY }) as T;
  return {
    ...fields,
    landlordName: '位置一號',
    landlordEmail: 'a@example.com',
    tenantName: '位置二號',
    tenantEmail: 'b@example.com',
    startDate: '2027-01-01',
    endDate: '2027-12-31',
  };
}

describe('案件種類與合約類型', () => {
  it('四種案件各建自己的合約：包租案件建包租合約，轉租案件建轉租合約', () => {
    expect(contractTypeForCaseKind('lease')).toBe('lease');
    expect(contractTypeForCaseKind('management')).toBe('management');
    expect(contractTypeForCaseKind('master_lease')).toBe('master_lease');
    expect(contractTypeForCaseKind('sublease')).toBe('sublease');
  });

  it('每種案件種類都有合約類型，反向對應回原案件種類', () => {
    for (const kind of STATUTORY_CASE_KINDS) {
      expect(caseKindForContractType(contractTypeForCaseKind(kind))).toBe(kind);
    }
  });

  it('舊業務類型的 master_lease 指轉租：包租案件與轉租案件的合約類型不能對調', () => {
    expect(contractTypeForCaseKind('master_lease')).not.toBe(contractTypeForCaseKind('sublease'));
    expect(routingSnapshotFor('master_lease', false)).toEqual({ businessType: 'self_managed', lesseeIsMasterLessor: true, brokerMediated: false });
    expect(routingSnapshotFor('sublease', true)).toEqual({ businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: true });
    expect(routingSnapshotFor('lease', false)).toBeUndefined();
    expect(routingSnapshotFor('management', false)).toBeUndefined();
  });
});

describe('稱謂與文件名', () => {
  it('包租合約是出租人與包租業，轉租合約是包租業與承租人', () => {
    expect(partyLabels('master_lease')).toMatchObject({ partyA: '出租人', partyB: '包租業', partyAFull: '甲方（出租人）', partyBFull: '乙方（包租業）' });
    expect(partyLabels('sublease')).toMatchObject({ partyA: '包租業', partyB: '承租人', partyAFull: '甲方（包租業）', partyBFull: '乙方（承租人）' });
  });

  it('文件名稱與當事人欄位標籤取自類型定義', () => {
    expect(contractTypeDefinition('master_lease').documentName).toBe('包租合約');
    expect(contractTypeDefinition('sublease').documentName).toBe('轉租合約');
    expect(contractTypeDefinition('master_lease').partyFieldLabels('party_b')).toEqual(['包租業姓名', '包租業 Email']);
    expect(contractTypeDefinition('sublease').partyFieldLabels('party_a')).toEqual(['包租業姓名', '包租業 Email']);
  });

  it('標籤不含舊用詞', () => {
    for (const type of ['master_lease', 'sublease'] as ContractType[]) {
      const def = contractTypeDefinition(type);
      const outputs = [def.documentName, ...Object.values(def.labels), ...def.partyFieldLabels('party_a'), ...def.partyFieldLabels('party_b')];
      for (const out of outputs) for (const term of LEGACY_TERMS.everywhere) expect(out).not.toContain(term);
    }
  });
});

describe('範本與法務審閱旗標', () => {
  it('兩種新類型各有自己的範本，且是未審閱', () => {
    expect(currentTemplate('master_lease')).toBe(MASTER_LEASE_TEMPLATE);
    expect(currentTemplate('sublease')).toBe(SUBLEASE_TEMPLATE);
    expect(MASTER_LEASE_TEMPLATE.legalReviewed).toBe(false);
    expect(SUBLEASE_TEMPLATE.legalReviewed).toBe(false);
    expect(new Set(['residential-lease', 'management-agreement', MASTER_LEASE_TEMPLATE.id, SUBLEASE_TEMPLATE.id]).size).toBe(4);
  });

  it('建立的草稿綁各自的範本，包租與轉租沒有選用條款', () => {
    for (const type of ['master_lease', 'sublease'] as const) {
      const fields = initialFieldsFor(type, { property: PROPERTY });
      const template = currentTemplate(type)!;
      expect(fields).toMatchObject({ templateId: template.id, templateVersion: 1, clauses: [] });
      expect(boundTemplateOf(type, fields)).toBe(template);
      expect(contractTypeDefinition(type).optionalClauses).toEqual([]);
    }
  });

  it('正式金鑰下，未審閱的包租與轉租範本無法送簽；沒有正式金鑰時放行', () => {
    for (const type of ['master_lease', 'sublease'] as const) {
      const fields = initialFieldsFor(type, { property: PROPERTY });
      expect(isLegalReviewed(type, fields)).toBe(false);
      expect(templateReviewBlock(type, fields, { DOTTEDSIGN_VERIFY_SIGNERS: '1' })).toMatchObject({
        code: TEMPLATE_NOT_REVIEWED_CODE,
        message: `${currentTemplate(type)!.name} v1 尚未經法務審閱，正式環境無法用它送簽`,
      });
      expect(templateReviewBlock(type, fields, {})).toBeNull();
    }
  });

  it('範本不跨類型：包租合約綁的範本，用轉租類型查不到', () => {
    const fields = initialFieldsFor('master_lease', { property: PROPERTY });
    expect(boundTemplateOf('sublease', fields)).toBeNull();
    expect(boundTemplateOf('lease', fields)).toBeNull();
  });
});

describe('建立草稿與欄位檢核', () => {
  it('從物件建立，帶入物件快照、設備附件與預設押金，需要物件', () => {
    for (const type of ['master_lease', 'sublease'] as const) {
      const def = contractTypeDefinition(type);
      expect(def.requiresProperty).toBe(true);
      expect(def.sendSupported).toBe(true);
      expect(() => def.initialFields({})).toThrow(/需要物件/);
      expect(initialFieldsFor(type, { property: PROPERTY })).toMatchObject({
        propertyName: '信義小宅',
        propertyAddress: '台北市信義區松仁路 1 號',
        rent: 18000,
        deposit: 36000,
        payDay: 5,
        equipmentAnnex: [
          { name: '冷氣', quantity: 2 },
          { name: '冰箱', quantity: 1 },
        ],
      });
    }
  });

  it('分流條件快照由合約類型決定，只有經紀居間取自輸入', () => {
    const broker = { businessType: 'managed', lesseeIsMasterLessor: true, brokerMediated: true } as const;
    expect(initialFieldsFor('master_lease', { property: PROPERTY, routing: broker }).routing).toEqual({
      businessType: 'self_managed',
      lesseeIsMasterLessor: true,
      brokerMediated: true,
    });
    expect(initialFieldsFor('sublease', { property: PROPERTY }).routing).toEqual({
      businessType: 'master_lease',
      lesseeIsMasterLessor: false,
      brokerMediated: false,
    });
  });

  it('依類型取當事人與寫入當事人，甲方是出租的一方', () => {
    const master = filled<MasterLeaseContractFields>('master_lease');
    const contract = { contract_type: 'master_lease' as const, fields: master };
    expect(partyOf(contract, 'party_a')).toEqual({ name: '位置一號', email: 'a@example.com' });
    expect(partyOf(contract, 'party_b')).toEqual({ name: '位置二號', email: 'b@example.com' });
    const next = withParty(contract, 'party_b', { name: '包租業公司', email: 'ops@example.com' });
    expect(partyOf({ contract_type: 'master_lease', fields: next }, 'party_b')).toEqual({ name: '包租業公司', email: 'ops@example.com' });
    expect(listSummaryOf(contract)).toMatchObject({ propertyName: '信義小宅', rent: 18000, period: ['2027-01-01', '2027-12-31'] });
  });

  it('必填檢核：姓名、Email、租期，標籤用法定稱謂', () => {
    const empty = initialFieldsFor('master_lease', { property: PROPERTY });
    expect(missingFieldsOf({ contract_type: 'master_lease', fields: empty })).toEqual([
      '出租人姓名',
      '出租人 Email',
      '包租業姓名',
      '包租業 Email',
      '租期起日',
      '租期迄日',
    ]);
    const emptySub = initialFieldsFor('sublease', { property: PROPERTY });
    expect(missingFieldsOf({ contract_type: 'sublease', fields: emptySub }).slice(0, 4)).toEqual([
      '包租業姓名',
      '包租業 Email',
      '承租人姓名',
      '承租人 Email',
    ]);
  });

  it('公告限制：租期不得少於三十日，押金最高不得超過二個月租金', () => {
    for (const type of ['master_lease', 'sublease'] as const) {
      const base = filled<MasterLeaseContractFields>(type);
      const shortTerm = { contract_type: type, fields: { ...base, startDate: '2027-01-01', endDate: '2027-01-29' } } as const;
      expect(missingFieldsOf(shortTerm as never)).toContain('租期（不得少於三十日）');
      const thirtyDays = { contract_type: type, fields: { ...base, startDate: '2027-01-01', endDate: '2027-01-30' } } as const;
      expect(missingFieldsOf(thirtyDays as never)).not.toContain('租期（不得少於三十日）');
      const highDeposit = { contract_type: type, fields: { ...base, rent: 10000, deposit: 20001 } } as const;
      expect(missingFieldsOf(highDeposit as never)).toContain('押金（最高不得超過二個月租金）');
      const twoMonths = { contract_type: type, fields: { ...base, rent: 10000, deposit: 20000 } } as const;
      expect(missingFieldsOf(twoMonths as never)).not.toContain('押金（最高不得超過二個月租金）');
    }
  });

  it('轉租期間不得逾包租契約的租賃期間（有填包租契約期間時）', () => {
    const base = filled<SubleaseContractFields>('sublease');
    const annex = defaultStatusAnnex();
    const rows = annex.rows.map((r) => ({ ...r, status: 'normal' as const }));
    const ok = { ...base, statusAnnex: { ...annex, rows }, masterLeaseStart: '2027-01-01', masterLeaseEnd: '2027-12-31' };
    expect(missingFieldsOf({ contract_type: 'sublease', fields: ok })).toEqual([]);
    const over = { ...ok, masterLeaseEnd: '2027-06-30' };
    expect(missingFieldsOf({ contract_type: 'sublease', fields: over })).toEqual(['租期迄日（不得逾包租契約之租賃期間）']);
    const early = { ...ok, masterLeaseStart: '2027-02-01' };
    expect(missingFieldsOf({ contract_type: 'sublease', fields: early })).toEqual(['租期起日（不得早於包租契約之租賃期間）']);
  });
});

describe('現況確認附件只跟轉租合約', () => {
  it('轉租合約必附，包租合約不附', () => {
    expect(statusAnnexRequired(initialFieldsFor('sublease', { property: PROPERTY }).routing, 'sublease')).toBe(true);
    expect(statusAnnexRequired(initialFieldsFor('master_lease', { property: PROPERTY }).routing, 'master_lease')).toBe(false);
    // 即使有人把轉租的分流條件傳給包租類型，也不附
    expect(statusAnnexRequired(routingSnapshotFor('sublease', false), 'master_lease')).toBe(false);
    expect(statusAnnexRequired(undefined, 'management')).toBe(false);
  });

  it('既有的租賃合約仍照分流條件：轉租案件的租賃合約必附，自管租賃合約不附', () => {
    expect(statusAnnexRequired({ businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false }, 'lease')).toBe(true);
    expect(statusAnnexRequired(undefined, 'lease')).toBe(false);
  });

  it('轉租合約的必填檢核包含附件，包租合約不檢查附件', () => {
    const sub = filled<SubleaseContractFields>('sublease');
    expect(missingFieldsOf({ contract_type: 'sublease', fields: sub })).toContain('現況確認附件尚有 10 項未填狀態');
    const master = filled<MasterLeaseContractFields>('master_lease');
    expect(missingFieldsOf({ contract_type: 'master_lease', fields: master })).toEqual([]);
  });

  it('草稿印預設附件，包租合約沒有附件', () => {
    const sub = filled<SubleaseContractFields>('sublease');
    expect(statusAnnexOf('draft', 'sublease', sub)).toEqual(defaultStatusAnnex());
    expect(statusAnnexOf('draft', 'master_lease', filled<MasterLeaseContractFields>('master_lease'))).toBeNull();
  });
});

describe('簽署序列與改之前相同（簽章分流規則表不動）', () => {
  const rows: [string, ContractType, ContractType, ContractRoutingConditions][] = [
    ['包租', 'lease', 'master_lease', { businessType: 'self_managed', lesseeIsMasterLessor: true, brokerMediated: false }],
    ['包租，經紀居間', 'lease', 'master_lease', { businessType: 'self_managed', lesseeIsMasterLessor: true, brokerMediated: true }],
    ['轉租', 'lease', 'sublease', { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false }],
    ['轉租，經紀居間', 'lease', 'sublease', { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: true }],
  ];

  it('規則表版本沒有升', () => {
    expect(SIGNATURE_RULES_VERSION).toBe(2);
  });

  it.each(rows)('%s：新類型與舊的租賃合約簽署序列相同', (_name, oldType, newType, routing) => {
    const before = evaluateRouting(routing, oldType);
    const after = evaluateRouting(routingSnapshotFor(newType, routing.brokerMediated), newType);
    if (!before.ok || !after.ok) throw new Error('預期兩邊都有簽署序列');
    expect(after.seats.map((s) => [s.ruleId, s.role])).toEqual(before.seats.map((s) => [s.ruleId, s.role]));
    expect(after.plan.seats.map((s) => s.requiredFieldPages)).toEqual(before.plan.seats.map((s) => s.requiredFieldPages));
  });

  it('包租合約的簽署序列：出租人先簽，專任管理人員，包租業最後；轉租合約：承租人先簽，專任管理人員，包租業最後', () => {
    const master = evaluateRouting(undefined, 'master_lease');
    const sub = evaluateRouting(undefined, 'sublease');
    if (!master.ok || !sub.ok) throw new Error('預期有簽署序列');
    expect(master.seats.map((s) => s.ruleId)).toEqual([
      'lease.self_managed_lessee_master_lessor.party_a',
      'lease.self_managed_lessee_master_lessor.practitioner',
      'lease.self_managed_lessee_master_lessor.party_b',
    ]);
    expect(sub.seats.map((s) => s.ruleId)).toEqual([
      'lease.master_lease.party_b',
      'lease.master_lease.practitioner',
      'lease.master_lease.party_a',
    ]);
    expect(master.seats[0].fullLabel).toBe('甲方（出租人）');
    expect(master.seats[2].fullLabel).toBe('乙方（包租業）');
    expect(sub.seats[0].fullLabel).toBe('乙方（承租人）');
    expect(sub.seats[2].fullLabel).toBe('甲方（包租業）');
  });

  it('分流條件快照的舊欄位互相矛盾時，新類型仍看合約類型', () => {
    const contradictory = { businessType: 'managed', lesseeIsMasterLessor: false, brokerMediated: false };
    const master = evaluateRouting(contradictory, 'master_lease');
    expect(master.ok).toBe(true);
    if (master.ok) expect(master.seats[0].ruleId).toBe('lease.self_managed_lessee_master_lessor.party_a');
  });

  it('既有的租賃合約仍照原本的分流條件，租賃合約的類型沒有改', () => {
    const lease: LeaseContractFields = {
      ...(initialFieldsFor('lease', { property: PROPERTY }) as LeaseContractFields),
    };
    expect(lease.templateId).toBe('residential-lease');
    const evaluation = evaluateRouting(lease.routing, 'lease');
    expect(evaluation.ok && evaluation.seats.map((s) => s.ruleId)).toEqual(['lease.self_managed.party_b', 'lease.self_managed.party_a']);
  });
});

async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push((content.items as { str: string }[]).map((item) => item.str).join(''));
  }
  return pages;
}

describe('PDF', () => {
  it('包租合約：標題與條文是住宅包租契約，簽署欄用法定稱謂，沒有現況確認附件', async () => {
    const renderer = contractPdfRenderer('master_lease');
    if (!renderer) throw new Error('包租合約應該有 PDF 產出函式');
    const fields = filled<MasterLeaseContractFields>('master_lease');
    const { pdf, pages } = await renderer.renderWithPages(fields, {}, { statusAnnex: defaultStatusAnnex() });
    const text = await pdfPages(pdf);
    const all = text.join('\n');
    expect(text[0]).toContain('住宅包租契約書');
    // pdfjs 讀回時全形空白會變成半形空白
    expect(all).toContain('第二十三條 當事人及相關人員基本資料');
    expect(all).not.toContain('現況確認');
    expect(all).not.toContain('房屋租賃契約書');
    expect(all).not.toContain('甲方');
    expect(all).not.toContain('乙方');
    expect(pages.statusAnnexPage).toBeNull();
    expect(pages.signaturePage).toBe(pages.pageCount - 1);
    expect(text[pages.signaturePage]).toContain('出租人：位置一號');
    expect(text[pages.signaturePage]).toContain('包租業：位置二號');
    // 「執業主體」含「業主」，先排除豁免詞再掃舊用詞
    const scanned = LEGACY_TERMS.exemptPhrases.reduce((s, phrase) => s.split(phrase).join(''), all);
    for (const legacy of [...LEGACY_TERMS.everywhere, ...LEGACY_TERMS.contractPdfAndLessee]) expect(scanned).not.toContain(legacy);
  });

  it('轉租合約：標題與條文是住宅轉租契約，現況確認附件排在簽署欄之後', async () => {
    const renderer = contractPdfRenderer('sublease');
    if (!renderer) throw new Error('轉租合約應該有 PDF 產出函式');
    const fields = filled<SubleaseContractFields>('sublease');
    const annex = statusAnnexOf('draft', 'sublease', fields);
    const { pdf, pages } = await renderer.renderWithPages(fields, {}, { statusAnnex: annex });
    const text = await pdfPages(pdf);
    const all = text.join('\n');
    expect(text[0]).toContain('住宅轉租契約書');
    expect(all).toContain('第二十四條 當事人及相關人員基本資料');
    expect(all).toContain('第一條 契約審閱期');
    expect(all).not.toContain('房屋租賃契約書');
    expect(pages.statusAnnexPage).not.toBeNull();
    expect(pages.statusAnnexPage!).toBeGreaterThan(pages.signaturePage);
    expect(text[pages.statusAnnexPage!]).toContain('現況確認附件');
    expect(text[pages.signaturePage]).toContain('包租業：位置一號');
    expect(text[pages.signaturePage]).toContain('承租人：位置二號');
    expect(text[pages.signaturePage]).toContain('執業人員');
  });

  it('轉租合約沒有傳附件內容時不印附件頁', async () => {
    const renderer = contractPdfRenderer('sublease')!;
    const { pages } = await renderer.renderWithPages(filled<SubleaseContractFields>('sublease'), {}, { statusAnnex: null });
    expect(pages.statusAnnexPage).toBeNull();
  });
});
