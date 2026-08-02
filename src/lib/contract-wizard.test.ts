import { describe, expect, it } from 'vitest';
import type { Contract, ContractFields, SignatureField } from './types';
import {
  WIZARD_STEPS,
  STEP_CONFIRM,
  STEP_FIELDS,
  STEP_PROPERTY,
  STEP_SIGNATURE,
  checkSignatureFields,
  missingFieldLabels,
  nextStepBlockReason,
  resumeStepIndex,
  sendBlockReason,
  stepStatuses,
} from './contract-wizard';

function fields(patch: Partial<ContractFields> = {}): ContractFields {
  return {
    landlordName: '王大明',
    landlordEmail: 'landlord@example.com',
    tenantName: '陳小美',
    tenantEmail: 'tenant@example.com',
    propertyName: '大安區溫馨兩房',
    propertyAddress: '台北市大安區和平東路二段 100 號 3 樓',
    propertyType: '整層住家',
    propertySize: 25,
    equipment: ['冷氣'],
    rent: 28000,
    deposit: 56000,
    startDate: '2026-09-01',
    endDate: '2027-08-31',
    payDay: 5,
    extra: '',
    ...patch,
  };
}

function sig(signer: SignatureField['signer'], id: string = signer): SignatureField {
  return { id, signer, page: 0, x: 0.5, y: 0.7, w: 0.3, h: 0.07 };
}

function contract(patch: Partial<Contract> = {}): Contract {
  return {
    id: 1,
    property_id: 3,
    status: 'draft',
    fields: fields(),
    signature_fields: [sig('landlord'), sig('tenant')],
    dottedsign_task_id: null,
    declined_reason: null,
    created_at: '2026-08-01 10:00:00',
    updated_at: null,
    ...patch,
  };
}

describe('wizard 步驟定義', () => {
  it('就是規格 §7 的四步，順序固定', () => {
    expect(WIZARD_STEPS.map((s) => s.key)).toEqual(['property', 'fields', 'signature', 'confirm']);
    expect(WIZARD_STEPS.map((s) => s.title)).toEqual([
      '物件與範本',
      '填寫欄位',
      '預覽與簽署區',
      '確認送簽',
    ]);
  });

  it('步驟索引常數與定義順序一致', () => {
    expect([STEP_PROPERTY, STEP_FIELDS, STEP_SIGNATURE, STEP_CONFIRM]).toEqual([0, 1, 2, 3]);
  });
});

describe('missingFieldLabels（第②步欄位驗證）', () => {
  it('欄位齊全時沒有缺漏', () => {
    expect(missingFieldLabels(fields())).toEqual([]);
  });

  it('列出所有空白的必填欄位', () => {
    expect(
      missingFieldLabels(
        fields({ landlordName: ' ', tenantName: '', rent: null, startDate: '', endDate: '' })
      )
    ).toEqual(['甲方姓名', '乙方姓名', '月租金', '租期起日', '租期迄日']);
  });

  it('Email 格式錯誤也算缺漏', () => {
    expect(missingFieldLabels(fields({ landlordEmail: 'not-an-email' }))).toEqual(['甲方 Email']);
    expect(missingFieldLabels(fields({ tenantEmail: 'tenant@example' }))).toEqual(['乙方 Email']);
  });

  it('租期迄日早於起日視為租期無效', () => {
    expect(missingFieldLabels(fields({ startDate: '2027-01-01', endDate: '2026-12-31' }))).toEqual([
      '租期迄日（不得早於起日）',
    ]);
  });

  it('租期起迄同一天可接受', () => {
    expect(missingFieldLabels(fields({ startDate: '2026-09-01', endDate: '2026-09-01' }))).toEqual([]);
  });

  it('押金、付款日、其他約定事項不是必填', () => {
    expect(missingFieldLabels(fields({ deposit: null, payDay: null, extra: '' }))).toEqual([]);
  });
});

describe('checkSignatureFields（簽署區檢核）', () => {
  it('甲乙各至少一框才算通過', () => {
    expect(checkSignatureFields([sig('landlord'), sig('tenant')])).toEqual({
      landlord: 1,
      tenant: 1,
      ok: true,
    });
  });

  it('只有一方時不通過', () => {
    expect(checkSignatureFields([sig('landlord')])).toEqual({ landlord: 1, tenant: 0, ok: false });
    expect(checkSignatureFields([])).toEqual({ landlord: 0, tenant: 0, ok: false });
  });

  it('同一方多框照數計算', () => {
    const list = [sig('landlord', 'a'), sig('landlord', 'b'), sig('tenant', 'c')];
    expect(checkSignatureFields(list)).toEqual({ landlord: 2, tenant: 1, ok: true });
  });
});

describe('nextStepBlockReason（擋下一步）', () => {
  const ok = { fields: fields(), signatureFields: [sig('landlord'), sig('tenant')] };

  it('第①步物件與範本不擋', () => {
    expect(nextStepBlockReason(STEP_PROPERTY, { fields: fields({ rent: null }), signatureFields: [] })).toBeNull();
  });

  it('第②步欄位未過就擋，並列出缺漏欄位', () => {
    expect(nextStepBlockReason(STEP_FIELDS, { ...ok, fields: fields({ tenantName: '' }) })).toBe(
      '請先完成欄位：乙方姓名'
    );
    expect(nextStepBlockReason(STEP_FIELDS, ok)).toBeNull();
  });

  it('第③步簽署區未達甲乙各一框就擋', () => {
    expect(nextStepBlockReason(STEP_SIGNATURE, { ...ok, signatureFields: [sig('landlord')] })).toBe(
      '請為甲乙雙方各設定至少一個簽名框（目前甲方 1 個、乙方 0 個）'
    );
    expect(nextStepBlockReason(STEP_SIGNATURE, ok)).toBeNull();
  });
});

describe('sendBlockReason（第④步送簽前檢核）', () => {
  it('欄位與簽署區都通過才放行', () => {
    expect(sendBlockReason({ fields: fields(), signatureFields: [sig('landlord'), sig('tenant')] })).toBeNull();
  });

  it('欄位缺漏優先回報', () => {
    expect(sendBlockReason({ fields: fields({ rent: null }), signatureFields: [] })).toBe(
      '請先完成欄位：月租金'
    );
  });

  it('欄位齊全但簽署區不足時回報簽署區', () => {
    expect(sendBlockReason({ fields: fields(), signatureFields: [sig('tenant')] })).toBe(
      '請為甲乙雙方各設定至少一個簽名框（目前甲方 0 個、乙方 1 個）'
    );
  });
});

describe('resumeStepIndex（中斷後回到合理的步驟）', () => {
  it('欄位還沒填完回到第②步', () => {
    expect(resumeStepIndex(contract({ fields: fields({ tenantName: '' }) }))).toBe(STEP_FIELDS);
  });

  it('剛從物件建立的空草稿回到第②步', () => {
    const blank = contract({
      fields: fields({ landlordName: '', landlordEmail: '', tenantName: '', tenantEmail: '', startDate: '', endDate: '' }),
      signature_fields: [],
    });
    expect(resumeStepIndex(blank)).toBe(STEP_FIELDS);
  });

  it('欄位齊全但簽署區未完成回到第③步', () => {
    expect(resumeStepIndex(contract({ signature_fields: [sig('tenant')] }))).toBe(STEP_SIGNATURE);
  });

  it('欄位與簽署區都齊全回到第④步確認送簽', () => {
    expect(resumeStepIndex(contract())).toBe(STEP_CONFIRM);
  });
});

describe('stepStatuses（Steps 每一步的狀態）', () => {
  const ok = { fields: fields(), signatureFields: [sig('landlord'), sig('tenant')] };

  it('目前步驟為 process，之前為 finish，之後為 wait', () => {
    expect(stepStatuses(STEP_SIGNATURE, ok)).toEqual(['finish', 'finish', 'process', 'wait']);
  });

  it('已走過但檢核未過的步驟標成 error', () => {
    expect(stepStatuses(STEP_CONFIRM, { ...ok, fields: fields({ rent: null }) })).toEqual([
      'finish',
      'error',
      'finish',
      'process',
    ]);
  });

  it('尚未走到的步驟即使未通過也維持 wait', () => {
    expect(stepStatuses(STEP_PROPERTY, { fields: fields({ rent: null }), signatureFields: [] })).toEqual([
      'process',
      'wait',
      'wait',
      'wait',
    ]);
  });
});
