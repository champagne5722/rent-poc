import { describe, expect, it } from 'vitest';
import {
  STEP_FIELDS,
  STEP_PROPERTY,
  STEP_SIGNATURE,
  nextStepBlockReason,
  pruneAssignments,
  resumeStepIndex,
  sendBlockReasons,
  signingSequenceNotice,
  stepStatuses,
} from './contract-wizard';
import type { MandateItem } from './mandate-schedule';
import type { ManagementContract, ManagementContractFields, SignatureField } from './types';
import { ulidOf } from './test-ids';

// 建約 wizard 的檢核依合約類型（MIL-74）：委託管理合約的簽署序列是甲方、執業人員、乙方。

const SLOT = 'management.managed.practitioner';
const FIELDS: ManagementContractFields = {
  mandatorName: '陳屋主',
  mandatorEmail: 'owner@example.com',
  mandataryName: '王建國',
  mandataryEmail: 'wang.jianguo@beichen.example.com',
  termStart: '2027-01-01',
  termEnd: '2027-12-31',
  feeMode: 'monthly_fixed',
  feeValue: 3000,
  extra: '',
};
const ITEMS: MandateItem[] = [
  { propertyId: '7', propertyName: '信義小宅', propertyAddress: '台北市信義區松仁路 1 號', scopes: ['rent_collection'] },
];
const ASSIGNMENT = { slot: SLOT, entityId: 'org-pe-beichen', practitionerId: 'pr-chen', partySignerId: 'ps-wang' };

const field = (signer: SignatureField['signer'], slot?: string): SignatureField => ({
  id: `${signer}-${slot ?? ''}`,
  signer,
  ...(slot ? { slot } : {}),
  page: 1,
  x: 0.1,
  y: 0.1,
  w: 0.2,
  h: 0.05,
});
const ALL_FIELDS = [field('party_a', 'management.managed.party_a'), field('practitioner', SLOT), field('party_b', 'management.managed.party_b')];

describe('委託管理合約的 wizard 檢核', () => {
  it('第①步沒有分流條件要填，不擋', () => {
    expect(nextStepBlockReason(STEP_PROPERTY, { contractType: 'management', fields: FIELDS, signatureFields: [] })).toBeNull();
  });

  it('第②步：受託人是執業主體，還沒選當事人簽署人時提示先選，不把乙方欄位列為缺漏', () => {
    const blank = { ...FIELDS, mandataryName: '', mandataryEmail: '' };
    expect(
      nextStepBlockReason(STEP_FIELDS, {
        contractType: 'management',
        fields: blank,
        signatureFields: [],
        assignments: [],
        mandateItems: ITEMS,
      }),
    ).toBe('請先指派乙方的當事人簽署人');
  });

  it('第②步：委託期間、報酬與委託標的清單缺漏時列出標籤', () => {
    const reason = nextStepBlockReason(STEP_FIELDS, {
      contractType: 'management',
      fields: { ...FIELDS, termEnd: '', feeMode: null },
      signatureFields: [],
      assignments: [ASSIGNMENT],
      mandateItems: [],
    });
    expect(reason).toBe('請先完成欄位：委託期間迄日、報酬約定、委託標的清單');
  });

  it('第②步：欄位、指派與清單都齊全時通過', () => {
    expect(
      nextStepBlockReason(STEP_FIELDS, {
        contractType: 'management',
        fields: FIELDS,
        signatureFields: [],
        assignments: [ASSIGNMENT],
        mandateItems: ITEMS,
      }),
    ).toBeNull();
  });

  it('第③步：每個席位至少一個簽署區域，缺的席位用委託人與受託人的稱謂說明', () => {
    const reason = nextStepBlockReason(STEP_SIGNATURE, {
      contractType: 'management',
      fields: FIELDS,
      signatureFields: [field('party_a', 'management.managed.party_a')],
    });
    expect(reason).toBe('請為下列簽署席位各設定至少一個簽名框：執業人員（租賃住宅管理人員）、乙方（受託人）');
  });

  it('送簽前的擋下原因一次列完：尚未指派執業人員與當事人簽署人', () => {
    const reasons = sendBlockReasons({
      contractType: 'management',
      fields: FIELDS,
      signatureFields: ALL_FIELDS,
      assignments: [],
      mandateItems: ITEMS,
    });
    expect(reasons).toEqual(['尚未指派執業人員（租賃住宅管理人員）']);
  });

  it('全部齊全時沒有擋下原因', () => {
    expect(
      sendBlockReasons({
        contractType: 'management',
        fields: FIELDS,
        signatureFields: ALL_FIELDS,
        assignments: [ASSIGNMENT],
        mandateItems: ITEMS,
      }),
    ).toEqual([]);
  });

  it('改欄位後指派只留簽署序列還有的席位：委託管理合約的執業人員席位不會被清掉', () => {
    expect(pruneAssignments(undefined, [ASSIGNMENT], 'management')).toEqual([ASSIGNMENT]);
    // 沒有帶類型時是租賃合約，自管沒有執業人員席位
    expect(pruneAssignments(undefined, [ASSIGNMENT])).toEqual([]);
  });

  it('確認頁說明依簽署序列：甲方（委託人）、執業人員、乙方（受託人）', () => {
    expect(signingSequenceNotice(FIELDS, 'management')).toBe(
      '送簽後依序簽署：甲方（委託人）、執業人員（租賃住宅管理人員）、乙方（受託人）。每位簽完才輪到下一位，全部簽完合約才成立。',
    );
  });

  it('續作落在第一個還沒完成的步驟', () => {
    const contract = (fields: ManagementContractFields, signature_fields: SignatureField[]): ManagementContract => ({
      id: ulidOf(1),
      property_id: null,
      status: 'draft',
      signature_fields,
      declined_reason: null,
      derived_from: null,
      created_at: '2026-11-09 00:00:00',
      updated_at: null,
      contract_type: 'management',
      fields,
    });
    expect(resumeStepIndex(contract({ ...FIELDS, termStart: '' }, []), { mandateItems: ITEMS })).toBe(STEP_FIELDS);
    expect(resumeStepIndex(contract(FIELDS, []), { mandateItems: [] })).toBe(STEP_FIELDS);
    expect(resumeStepIndex(contract(FIELDS, []), { mandateItems: ITEMS })).toBe(STEP_SIGNATURE);
  });

  it('步驟列：走過但檢核未過的步驟標 error', () => {
    const statuses = stepStatuses(STEP_SIGNATURE, {
      contractType: 'management',
      fields: { ...FIELDS, termStart: '' },
      signatureFields: [],
      assignments: [ASSIGNMENT],
      mandateItems: ITEMS,
    });
    expect(statuses[STEP_FIELDS]).toBe('error');
  });
});
