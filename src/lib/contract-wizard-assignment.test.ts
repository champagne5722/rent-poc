import { describe, expect, it } from 'vitest';
import {
  STEP_FIELDS,
  applyPartySigner,
  nextStepBlockReason,
  pruneAssignments,
  sendBlockReasons,
} from './contract-wizard';
import type { PractitionerAssignmentInput } from './practitioner-assignment/seats';
import type { LeaseContractFields, ContractRoutingConditions, SignatureField } from './types';

// 建約 wizard 的執業人員指派（MIL-69）：指派影響擋下一步、送簽前原因與簽署欄資料。

function fields(routing?: ContractRoutingConditions, patch: Partial<LeaseContractFields> = {}): LeaseContractFields {
  return {
    ...(routing ? { routing } : {}),
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
    ...patch,
  };
}

const MASTER: ContractRoutingConditions = { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false };
const MASTER_BROKER: ContractRoutingConditions = { ...MASTER, brokerMediated: true };
const REVERSED: ContractRoutingConditions = { businessType: 'self_managed', lesseeIsMasterLessor: true, brokerMediated: false };

const P = 'lease.master_lease.practitioner';
const sig = (signer: SignatureField['signer'], slot: string): SignatureField => ({
  id: slot,
  signer,
  slot,
  page: 0,
  x: 0.5,
  y: 0.7,
  w: 0.3,
  h: 0.07,
});
const masterFields = [sig('party_b', 'lease.master_lease.party_b'), sig('practitioner', P), sig('party_a', 'lease.master_lease.party_a')];

const ASSIGNED: PractitionerAssignmentInput = { slot: P, entityId: 'org-pe-beichen', practitionerId: 'pr-chen', partySignerId: 'ps-wang' };

describe('sendBlockReasons 看指派', () => {
  it('已指派且當事人簽署人齊全：不再列未指派', () => {
    expect(sendBlockReasons({ fields: fields(MASTER), signatureFields: masterFields, assignments: [ASSIGNED] })).toEqual([]);
  });

  it('沒有指派：列未指派（與指派功能之前的文字相同）', () => {
    expect(sendBlockReasons({ fields: fields(MASTER), signatureFields: masterFields, assignments: [] })).toEqual([
      '尚未指派執業人員（租賃住宅管理人員）',
    ]);
  });

  it('只選了執業主體、還沒選執業人員：仍列未指派', () => {
    expect(
      sendBlockReasons({
        fields: fields(MASTER),
        signatureFields: masterFields,
        assignments: [{ ...ASSIGNED, practitionerId: '' }],
      }),
    ).toEqual(['尚未指派執業人員（租賃住宅管理人員）']);
  });

  it('選了執業人員但沒有當事人簽署人：列出缺少的當事人簽署人', () => {
    expect(
      sendBlockReasons({
        fields: fields(MASTER),
        signatureFields: masterFields,
        assignments: [{ ...ASSIGNED, partySignerId: null }],
      }),
    ).toEqual(['尚未指派甲方的當事人簽署人']);
  });

  it('居間：經紀人席位不需要當事人簽署人', () => {
    const broker: PractitionerAssignmentInput = {
      slot: 'lease.broker',
      entityId: 'org-pe-yunding',
      practitionerId: 'pr-zhao',
      partySignerId: null,
    };
    expect(
      sendBlockReasons({
        fields: fields(MASTER_BROKER),
        signatureFields: [...masterFields, sig('practitioner', 'lease.broker')],
        assignments: [ASSIGNED, broker],
      }),
    ).toEqual([]);
    expect(
      sendBlockReasons({
        fields: fields(MASTER_BROKER),
        signatureFields: [...masterFields, sig('practitioner', 'lease.broker')],
        assignments: [ASSIGNED],
      }),
    ).toEqual(['尚未指派執業人員（不動產經紀人）']);
  });
});

describe('第②步：執業主體是甲乙方時，要先選當事人簽署人', () => {
  const state = (assignments?: PractitionerAssignmentInput[], f = fields(MASTER)) => ({ fields: f, signatureFields: [], assignments });

  it('包租但還沒選當事人簽署人：擋下一步', () => {
    expect(nextStepBlockReason(STEP_FIELDS, state([]))).toBe('請先指派甲方的當事人簽署人');
  });
  it('選定後通過', () => {
    expect(nextStepBlockReason(STEP_FIELDS, state([ASSIGNED]))).toBeNull();
  });
  it('自管且承租人是包租業者：要選乙方的當事人簽署人', () => {
    expect(nextStepBlockReason(STEP_FIELDS, state([], fields(REVERSED)))).toBe('請先指派乙方的當事人簽署人');
  });
  it('欄位本身缺漏時，先回報欄位', () => {
    expect(nextStepBlockReason(STEP_FIELDS, state([], fields(MASTER, { rent: null })))).toBe('請先完成欄位：月租金');
  });
  it('兩方合約不受影響', () => {
    expect(nextStepBlockReason(STEP_FIELDS, state([], fields()))).toBeNull();
  });
  it('沒有帶指派資料（舊用法）時不檢查', () => {
    expect(nextStepBlockReason(STEP_FIELDS, state(undefined))).toBeNull();
  });
});

describe('pruneAssignments：分流條件改變後，只留簽署序列還有的席位', () => {
  it('席位還在：保留', () => {
    expect(pruneAssignments(MASTER, [ASSIGNED])).toEqual([ASSIGNED]);
  });
  it('改成自管：執業人員席位消失，指派移除', () => {
    expect(pruneAssignments({ ...MASTER, businessType: 'self_managed' }, [ASSIGNED])).toEqual([]);
  });
  it('居間改成沒有：只移除經紀人席位的指派', () => {
    const broker: PractitionerAssignmentInput = { slot: 'lease.broker', entityId: 'e', practitionerId: 'p', partySignerId: null };
    expect(pruneAssignments(MASTER, [ASSIGNED, broker])).toEqual([ASSIGNED]);
  });
  it('分流條件無效：全部移除', () => {
    expect(pruneAssignments({ businessType: 'managed', lesseeIsMasterLessor: true, brokerMediated: false }, [ASSIGNED])).toEqual([]);
  });
});

describe('applyPartySigner：選當事人簽署人時帶入合約欄位', () => {
  const signer = { name: '李淑芬', email: 'li@beichen.example.com' };
  it('甲方', () => {
    expect(applyPartySigner(fields(MASTER), 'party_a', signer)).toMatchObject({
      landlordName: '李淑芬',
      landlordEmail: 'li@beichen.example.com',
      tenantName: '陳小美',
    });
  });
  it('乙方', () => {
    expect(applyPartySigner(fields(REVERSED), 'party_b', signer)).toMatchObject({
      tenantName: '李淑芬',
      tenantEmail: 'li@beichen.example.com',
      landlordName: '王建國',
    });
  });
  it('不改動原物件', () => {
    const original = fields(MASTER);
    applyPartySigner(original, 'party_a', signer);
    expect(original.landlordName).toBe('王建國');
  });
});
