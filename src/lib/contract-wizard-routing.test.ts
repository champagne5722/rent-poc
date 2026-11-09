import { describe, expect, it } from 'vitest';
import { evaluateRouting } from './signature-routing';
import { defaultStatusAnnex } from './status-annex';
import type { LeaseContract, LeaseContractFields, ContractRoutingConditions, SignatureField } from './types';
import {
  STEP_CONFIRM,
  STEP_FIELDS,
  STEP_PROPERTY,
  STEP_SIGNATURE,
  TENANT_FIRST_NOTICE,
  applyRoutingChange,
  nextStepBlockReason,
  resumeStepIndex,
  sendBlockReason,
  sendBlockReasons,
  signingSequenceNotice,
  signingSequenceTitle,
  stepStatuses,
} from './contract-wizard';

const FILLED_STATUS_ANNEX = (() => {
  const annex = defaultStatusAnnex();
  return { ...annex, rows: annex.rows.map((r) => ({ ...r, status: 'normal' as const })) };
})();

function fields(routing?: ContractRoutingConditions): LeaseContractFields {
  return {
    ...(routing ? { routing } : {}),
    landlordName: '王大明',
    landlordEmail: 'landlord@example.com',
    tenantName: '陳小美',
    tenantEmail: 'tenant@example.com',
    propertyName: '大安區溫馨兩房',
    propertyAddress: '台北市大安區和平東路二段 100 號 3 樓',
    propertyType: '整層住家',
    propertySize: 25,
    equipmentAnnex: [],
    // 包租租賃合約必附現況確認附件（MIL-71）。夾具給填完的附件，這個檔案測的是指派與簽署區
    statusAnnex: FILLED_STATUS_ANNEX,
    rent: 28000,
    deposit: 56000,
    startDate: '2026-09-01',
    endDate: '2027-08-31',
    payDay: 5,
    extra: '',
  };
}

const routing = (patch: Partial<ContractRoutingConditions> = {}): ContractRoutingConditions => ({
  businessType: 'self_managed',
  lesseeIsMasterLessor: false,
  brokerMediated: false,
  ...patch,
});

const MASTER = routing({ businessType: 'master_lease' });
const MASTER_BROKER = routing({ businessType: 'master_lease', brokerMediated: true });
// 規則表的 rule_id，手寫自 ADR-0018 決議 5（列的 id 加席位名）
const MASTER_B = 'lease.master_lease.party_b';
const MASTER_P = 'lease.master_lease.practitioner';
const MASTER_A = 'lease.master_lease.party_a';
const BROKER = 'lease.broker';

function sig(signer: SignatureField['signer'], slot?: string, id = `${signer}-${slot ?? 'legacy'}`): SignatureField {
  return { id, signer, ...(slot ? { slot } : {}), page: 0, x: 0.5, y: 0.7, w: 0.3, h: 0.07 };
}

const masterFields = [sig('party_b', MASTER_B), sig('practitioner', MASTER_P), sig('party_a', MASTER_A)];

function contract(patch: Partial<LeaseContract> = {}): LeaseContract {
  return {
    id: 1,
    property_id: 3,
    contract_type: 'lease',
    status: 'draft',
    fields: fields(),
    signature_fields: [sig('party_a'), sig('party_b')],
    declined_reason: null,
    derived_from: null,
    created_at: '2026-08-01 10:00:00',
    updated_at: null,
    ...patch,
  };
}

describe('第①步：規則未定義的分流條件擋下一步', () => {
  const undefinedCombo = routing({ businessType: 'managed', lesseeIsMasterLessor: true });

  it('顯示原因並擋下一步', () => {
    const reason = nextStepBlockReason(STEP_PROPERTY, { fields: fields(undefinedCombo), signatureFields: [] });
    expect(reason).toContain('規則表沒有定義');
    expect(reason).toContain('代管、承租人是包租業者');
  });

  it('規則有定義的組合不擋，沒有分流條件的既有草稿也不擋', () => {
    expect(nextStepBlockReason(STEP_PROPERTY, { fields: fields(MASTER_BROKER), signatureFields: [] })).toBeNull();
    expect(nextStepBlockReason(STEP_PROPERTY, { fields: fields(), signatureFields: [] })).toBeNull();
  });

  it('後面的步驟也擋，避免略過第①步', () => {
    const state = { fields: fields(undefinedCombo), signatureFields: [sig('party_a'), sig('party_b')] };
    expect(nextStepBlockReason(STEP_SIGNATURE, state)).toContain('規則表沒有定義');
    expect(sendBlockReasons(state).join('\n')).toContain('規則表沒有定義');
  });

  it('Steps 把第①步標成 error', () => {
    const state = { fields: fields(undefinedCombo), signatureFields: [] };
    expect(stepStatuses(STEP_FIELDS, state)[STEP_PROPERTY]).toBe('error');
  });

  it('續作時回到第①步', () => {
    expect(resumeStepIndex(contract({ fields: fields(undefinedCombo) }))).toBe(STEP_PROPERTY);
  });
});

describe('第③步：每個簽署席位至少一個簽署區域', () => {
  it('缺哪個席位就列出哪個', () => {
    const reason = nextStepBlockReason(STEP_SIGNATURE, {
      fields: fields(MASTER),
      signatureFields: [sig('party_b', MASTER_B), sig('party_a', MASTER_A)],
    });
    expect(reason).toContain('執業人員（租賃住宅管理人員）');
    expect(reason).not.toContain('乙方');
  });

  it('包租加居間時經紀人是另一個席位，管理人員的區域不能頂替', () => {
    const state = { fields: fields(MASTER_BROKER), signatureFields: masterFields };
    expect(nextStepBlockReason(STEP_SIGNATURE, state)).toContain('執業人員（不動產經紀人）');
    const complete = { ...state, signatureFields: [...masterFields, sig('practitioner', BROKER)] };
    expect(nextStepBlockReason(STEP_SIGNATURE, complete)).toBeNull();
  });

  it('舊資料沒有 slot，以簽署角色對應，自管合約仍是甲乙各一框', () => {
    const state = { fields: fields(), signatureFields: [sig('party_a'), sig('party_b')] };
    expect(nextStepBlockReason(STEP_SIGNATURE, state)).toBeNull();
    expect(nextStepBlockReason(STEP_SIGNATURE, { ...state, signatureFields: [sig('party_a')] })).toBe(
      '請為甲乙雙方各設定至少一個簽名框（目前甲方 1 個、乙方 0 個）',
    );
  });

  it('明確填了自管分流條件，訊息與沒有分流條件時相同', () => {
    const state = { fields: fields(routing()), signatureFields: [sig('party_b')] };
    expect(nextStepBlockReason(STEP_SIGNATURE, state)).toBe(
      '請為甲乙雙方各設定至少一個簽名框（目前甲方 0 個、乙方 1 個）',
    );
  });

  it('續作時簽署區不齊全回到第③步', () => {
    expect(
      resumeStepIndex(contract({ fields: fields(MASTER), signature_fields: [sig('party_b', MASTER_B), sig('party_a', MASTER_A)] })),
    ).toBe(STEP_SIGNATURE);
    expect(resumeStepIndex(contract({ fields: fields(MASTER), signature_fields: masterFields }))).toBe(STEP_CONFIRM);
  });
});

describe('送簽前檢核：規則要求執業人員但尚未指派時擋下並列出原因', () => {
  it('簽署區齊全，仍因未指派執業人員被擋下', () => {
    const reasons = sendBlockReasons({ fields: fields(MASTER), signatureFields: masterFields });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toBe('尚未指派執業人員（租賃住宅管理人員）');
  });

  it('包租加居間：管理人員與經紀人各列一條', () => {
    const reasons = sendBlockReasons({
      fields: fields(MASTER_BROKER),
      signatureFields: [...masterFields, sig('practitioner', BROKER)],
    });
    expect(reasons).toEqual(['尚未指派執業人員（租賃住宅管理人員）', '尚未指派執業人員（不動產經紀人）']);
  });

  it('一次列出所有原因：欄位缺漏、缺簽署區、未指派', () => {
    const reasons = sendBlockReasons({ fields: { ...fields(MASTER), rent: null }, signatureFields: [sig('party_b', MASTER_B)] });
    expect(reasons).toHaveLength(3);
    expect(reasons[0]).toBe('請先完成欄位：月租金');
    expect(reasons[1]).toContain('執業人員（租賃住宅管理人員）');
    expect(reasons[1]).toContain('甲方（出租人）');
    expect(reasons[2]).toBe('尚未指派執業人員（租賃住宅管理人員）');
  });

  it('不需要執業人員的組合不受影響', () => {
    expect(sendBlockReasons({ fields: fields(), signatureFields: [sig('party_a'), sig('party_b')] })).toEqual([]);
    expect(
      sendBlockReasons({
        fields: fields(routing({ businessType: 'managed' })),
        signatureFields: [sig('party_a'), sig('party_b')],
      }),
    ).toEqual([]);
  });

  it('sendBlockReason 回第一條，欄位缺漏優先', () => {
    expect(sendBlockReason({ fields: { ...fields(MASTER), rent: null }, signatureFields: masterFields })).toBe(
      '請先完成欄位：月租金',
    );
  });
});

describe('signingSequenceNotice（確認頁的簽署順序說明）', () => {
  it('乙方先簽、甲方後簽的序列沿用原文字', () => {
    expect(signingSequenceNotice(fields())).toBe(TENANT_FIRST_NOTICE);
    expect(signingSequenceNotice(fields(routing({ businessType: 'managed' })))).toBe(TENANT_FIRST_NOTICE);
  });

  it('說明用承租人、出租人的稱謂，不再寫租客與甲方（您）', () => {
    expect(TENANT_FIRST_NOTICE).toBe(
      '送簽後由乙方（承租人）先簽，乙方完成後才輪到甲方（出租人）簽署，雙方都簽完合約才成立。',
    );
    expect(TENANT_FIRST_NOTICE).not.toMatch(/租客|房東|您/);
  });

  it('其他序列由席位產生', () => {
    expect(signingSequenceNotice(fields(MASTER))).toBe(
      '送簽後依序簽署：乙方（承租人）、執業人員（租賃住宅管理人員）、甲方（出租人）。每位簽完才輪到下一位，全部簽完合約才成立。',
    );
    expect(signingSequenceNotice(fields(routing({ lesseeIsMasterLessor: true })))).toContain(
      '甲方（出租人）、執業人員（租賃住宅管理人員）、乙方（承租人）',
    );
  });
});

describe('applyRoutingChange（改分流條件時一併整理簽署區域）', () => {
  it('寫入 fields.routing，簽署區域不受影響時原樣保留', () => {
    const result = applyRoutingChange(fields(), [sig('party_a'), sig('party_b')], routing({ businessType: 'managed' }));
    expect(result.fields.routing).toEqual(routing({ businessType: 'managed' }));
    expect(result.signatureFields.map((f) => f.signer)).toEqual(['party_a', 'party_b']);
    expect(result.removed).toBe(0);
  });

  it('序列沒有執業人員後，移除他的簽署區域並回報數量', () => {
    const result = applyRoutingChange(fields(MASTER), masterFields, routing());
    expect(result.signatureFields.map((f) => f.signer).sort()).toEqual(['party_a', 'party_b']);
    expect(result.removed).toBe(1);
  });

  it('slot 隨新序列換成新列的 rule_id', () => {
    const result = applyRoutingChange(fields(MASTER), masterFields, routing({ businessType: 'managed' }));
    expect(result.signatureFields.find((f) => f.signer === 'party_a')?.slot).toBe('lease.managed.party_a');
  });

  it('規則未定義的組合：只寫入條件，不動簽署區域', () => {
    const undefinedCombo = routing({ businessType: 'managed', lesseeIsMasterLessor: true });
    const result = applyRoutingChange(fields(MASTER), masterFields, undefinedCombo);
    expect(result.fields.routing).toEqual(undefinedCombo);
    expect(result.signatureFields).toEqual(masterFields);
    expect(result.removed).toBe(0);
  });

  it('不就地改寫原本的欄位', () => {
    const original = fields();
    applyRoutingChange(original, [], MASTER);
    expect(original.routing).toBeUndefined();
  });
});

describe('signingSequenceNotice：同一人兼任合併後（MIL-76）', () => {
  const merges = [{ practitionerRuleId: 'lease.master_lease.practitioner', partyRuleId: 'lease.master_lease.party_a' }];

  it('列出合併後實際的簽署人，並說明兼任者只簽一次', () => {
    expect(signingSequenceNotice(fields(MASTER), 'lease', merges)).toBe(
      '送簽後依序簽署：乙方（承租人）、執業人員（租賃住宅管理人員）兼甲方（出租人）。每位簽完才輪到下一位，兼任者只簽一次，全部簽完合約才成立。',
    );
  });

  it('沒有合併時文字不變', () => {
    expect(signingSequenceNotice(fields(MASTER), 'lease', [])).toBe(signingSequenceNotice(fields(MASTER)));
  });
});

describe('確認頁的簽署順序由簽署序列產生（MIL-72）', () => {
  const FOUR_ROUTING = routing({ businessType: 'master_lease', brokerMediated: true });

  it('標題：兩方是「乙方先簽」，三位以上是「依序簽署」', () => {
    expect(signingSequenceTitle(fields())).toBe('乙方先簽');
    expect(signingSequenceTitle(fields(routing({ businessType: 'managed' })))).toBe('乙方先簽');
    expect(signingSequenceTitle(fields(MASTER))).toBe('依序簽署');
    expect(signingSequenceTitle(fields(FOUR_ROUTING))).toBe('依序簽署');
  });

  it('四位：居間加包租，依序列出四位，經紀人排最後', () => {
    const notice = signingSequenceNotice(fields(FOUR_ROUTING));
    expect(notice).toMatch(/^送簽後依序簽署：乙方（承租人）、執業人員（[^）]+）、甲方（出租人）、執業人員（[^）]+）。/);
    expect(notice.split('、')).toHaveLength(4);
  });

  it('席位 4、簽署人 3：合併後列出三位', () => {
    const evaluation = evaluateRouting(FOUR_ROUTING);
    expect(evaluation.ok).toBe(true);
    const seats = evaluation.ok ? evaluation.seats : [];
    const [, practitioner, partyA] = seats;
    const real = [{ practitionerRuleId: practitioner.ruleId, partyRuleId: partyA.ruleId }];
    const notice = signingSequenceNotice(fields(FOUR_ROUTING), 'lease', real);
    expect(notice.split('、')).toHaveLength(3);
    expect(notice).toContain('兼甲方（出租人）');
    expect(notice).toContain('兼任者只簽一次');
  });

  it('分流條件無效時退回兩方說明，不留空白', () => {
    const undefinedCombo = routing({ businessType: 'managed', lesseeIsMasterLessor: true });
    expect(signingSequenceNotice(fields(undefinedCombo))).toBe(TENANT_FIRST_NOTICE);
    expect(signingSequenceTitle(fields(undefinedCombo))).toBe('乙方先簽');
  });
});
