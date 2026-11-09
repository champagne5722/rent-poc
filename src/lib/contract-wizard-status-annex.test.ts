import { describe, expect, it } from 'vitest';
import { STEP_FIELDS, STEP_SIGNATURE, nextStepBlockReason, sendBlockReasons, type WizardState } from './contract-wizard';
import { evaluateRouting, seatViewsMissingStatusAnnex } from './signature-routing';
import { defaultStatusAnnex, type StatusAnnex } from './status-annex';
import type { ContractRoutingConditions, LeaseContractFields, SignatureField } from './types';

// 建約 wizard 的現況確認附件（MIL-71）：第②步要填完附件，第③步附件頁要有執業人員的簽名框。
// 附件頁的頁碼由簽署區編輯器讀 PDF 後回報（pages），沒有回報時 wizard 不判斷，由伺服器的送簽前檢查擋下。

const MASTER: ContractRoutingConditions = { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false };
const SELF: ContractRoutingConditions = { businessType: 'self_managed', lesseeIsMasterLessor: false, brokerMediated: false };
const PRACTITIONER = 'lease.master_lease.practitioner';

function filled(): StatusAnnex {
  const annex = defaultStatusAnnex();
  return { ...annex, rows: annex.rows.map((r) => ({ ...r, status: 'normal' as const })) };
}

function fields(routing: ContractRoutingConditions, statusAnnex?: StatusAnnex): LeaseContractFields {
  return {
    routing,
    landlordName: '王建國',
    landlordEmail: 'wang@beichen.example.com',
    tenantName: '陳小美',
    tenantEmail: 'tenant@example.com',
    propertyName: '大安區溫馨兩房',
    propertyAddress: '台北市大安區和平東路二段 100 號 3 樓',
    propertyType: '整層住家',
    propertySize: 25,
    equipmentAnnex: [],
    rent: 28000,
    deposit: 56000,
    startDate: '2026-09-01',
    endDate: '2027-08-31',
    payDay: 5,
    extra: '',
    ...(statusAnnex ? { statusAnnex } : {}),
  };
}

const box = (id: string, signer: SignatureField['signer'], page: number, slot: string): SignatureField => ({
  id,
  signer,
  slot,
  page,
  x: 0.1,
  y: 0.8,
  w: 0.2,
  h: 0.1,
});

const BODY: SignatureField[] = [
  box('b', 'party_b', 1, 'lease.master_lease.party_b'),
  box('p', 'practitioner', 1, PRACTITIONER),
  box('a', 'party_a', 1, 'lease.master_lease.party_a'),
];
const PAGES = { pageCount: 4, signaturePage: 1, statusAnnexPage: 3 };
const ANNEX_MESSAGE = '請在現況確認附件頁為執業人員（租賃住宅管理人員）放置簽名框';

function state(patch: Partial<WizardState>): WizardState {
  return { contractType: 'lease', fields: fields(MASTER, filled()), signatureFields: BODY, ...patch };
}

describe('第②步：附件沒填完不能往下', () => {
  it('包租租賃合約附件未填，擋下一步並列出項數', () => {
    const reason = nextStepBlockReason(STEP_FIELDS, state({ fields: fields(MASTER) }));
    expect(reason).toMatch(/^請先完成欄位：現況確認附件尚有 \d+ 項未填狀態$/);
  });

  it('填完後通過', () => {
    expect(nextStepBlockReason(STEP_FIELDS, state({}))).toBeNull();
  });

  it('自管租賃合約不檢查附件', () => {
    expect(nextStepBlockReason(STEP_FIELDS, state({ fields: fields(SELF), signatureFields: [] }))).toBeNull();
  });
});

describe('第③步：附件頁要有執業人員的簽名框', () => {
  it('編輯器回報附件頁後，缺少時擋下一步', () => {
    expect(nextStepBlockReason(STEP_SIGNATURE, state({ pages: PAGES }))).toBe(ANNEX_MESSAGE);
  });

  it('附件頁有執業人員的框就通過', () => {
    const signatureFields = [...BODY, box('p2', 'practitioner', 3, PRACTITIONER)];
    expect(nextStepBlockReason(STEP_SIGNATURE, state({ pages: PAGES, signatureFields }))).toBeNull();
  });

  it('還沒有頁面地圖，或 PDF 沒有附件頁時，wizard 不判斷', () => {
    expect(nextStepBlockReason(STEP_SIGNATURE, state({}))).toBeNull();
    expect(nextStepBlockReason(STEP_SIGNATURE, state({ pages: { ...PAGES, statusAnnexPage: null } }))).toBeNull();
  });

  it('每個席位至少一框的檢核優先', () => {
    const reason = nextStepBlockReason(STEP_SIGNATURE, state({ pages: PAGES, signatureFields: [BODY[0], BODY[2]] }));
    expect(reason).toContain('請為下列簽署席位各設定至少一個簽名框');
  });

  it('送簽前的原因清單一併列出', () => {
    const reasons = sendBlockReasons(state({ pages: PAGES, assignments: [] }));
    expect(reasons).toContain(ANNEX_MESSAGE);
  });
});

describe('seatViewsMissingStatusAnnex：給編輯器的提示', () => {
  const evaluation = evaluateRouting(MASTER, 'lease');
  const seats = evaluation.ok ? evaluation.seats : [];

  it('只有規則列要求的席位帶標記', () => {
    expect(seats.filter((s) => s.requiresStatusAnnex).map((s) => s.ruleId)).toEqual([PRACTITIONER]);
  });

  it('列出附件頁還沒有框的席位', () => {
    expect(seatViewsMissingStatusAnnex(seats, BODY, 3).map((s) => s.ruleId)).toEqual([PRACTITIONER]);
    expect(seatViewsMissingStatusAnnex(seats, [...BODY, box('p2', 'practitioner', 3, PRACTITIONER)], 3)).toEqual([]);
  });

  it('沒有附件頁時不提示', () => {
    expect(seatViewsMissingStatusAnnex(seats, BODY, null)).toEqual([]);
  });

  it('自管租賃合約沒有席位需要附件頁', () => {
    const self = evaluateRouting(SELF, 'lease');
    expect(self.ok && self.seats.some((s) => s.requiresStatusAnnex)).toBe(false);
  });
});
