import { describe, expect, it } from 'vitest';
import type { Contract, ContractFields, SignatureField } from './types';
import { CONTRACT_PARTY_ROLES, SIGNER_ROLE_LABELS } from './types';
import {
  WIZARD_STEPS,
  STEP_CONFIRM,
  STEP_FIELDS,
  STEP_PROPERTY,
  STEP_SIGNATURE,
  checkSignatureFields,
  mergeEditableFields,
  missingFieldLabels,
  nextStepBlockReason,
  resumeStepIndex,
  sendBlockReason,
  stepStatuses,
  upgradeDraftFields,
} from './contract-wizard';
import { DEFAULT_TEMPLATE, findClause, upgradeNotice } from './clause-library';
import { ulidOf } from './test-ids';

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
    equipmentAnnex: [{ name: '冷氣', quantity: 1, repair: 'landlord', note: '' }],
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
    id: ulidOf(1),
    property_id: '01HF7YAT00ABCDEFGHJKMNPQRS',
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

describe('簽署角色的畫面標籤', () => {
  it('畫面顯示甲方、乙方、執業人員', () => {
    expect(SIGNER_ROLE_LABELS).toEqual({ party_a: '甲方', party_b: '乙方', practitioner: '執業人員' });
  });

  it('合約當事人的簽署角色只有甲方與乙方（執業人員的席位由簽署序列提供）', () => {
    expect(CONTRACT_PARTY_ROLES).toEqual(['party_a', 'party_b']);
  });
});

describe('checkSignatureFields（簽署區檢核）', () => {
  it('甲乙各至少一框才算通過', () => {
    expect(checkSignatureFields([sig('party_a'), sig('party_b')])).toEqual({
      party_a: 1,
      party_b: 1,
      ok: true,
    });
  });

  it('只有一方時不通過', () => {
    expect(checkSignatureFields([sig('party_a')])).toEqual({ party_a: 1, party_b: 0, ok: false });
    expect(checkSignatureFields([])).toEqual({ party_a: 0, party_b: 0, ok: false });
  });

  it('同一方多框照數計算', () => {
    const list = [sig('party_a', 'a'), sig('party_a', 'b'), sig('party_b', 'c')];
    expect(checkSignatureFields(list)).toEqual({ party_a: 2, party_b: 1, ok: true });
  });

  it('執業人員的簽署區域不能頂替甲方或乙方', () => {
    const list = [sig('party_a'), sig('practitioner')];
    expect(checkSignatureFields(list)).toEqual({ party_a: 1, party_b: 0, ok: false });
  });
});

describe('nextStepBlockReason（擋下一步）', () => {
  const ok = { fields: fields(), signatureFields: [sig('party_a'), sig('party_b')] };

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
    expect(nextStepBlockReason(STEP_SIGNATURE, { ...ok, signatureFields: [sig('party_a')] })).toBe(
      '請為甲乙雙方各設定至少一個簽名框（目前甲方 1 個、乙方 0 個）'
    );
    expect(nextStepBlockReason(STEP_SIGNATURE, ok)).toBeNull();
  });
});

describe('sendBlockReason（第④步送簽前檢核）', () => {
  it('欄位與簽署區都通過才放行', () => {
    expect(sendBlockReason({ fields: fields(), signatureFields: [sig('party_a'), sig('party_b')] })).toBeNull();
  });

  it('欄位缺漏優先回報', () => {
    expect(sendBlockReason({ fields: fields({ rent: null }), signatureFields: [] })).toBe(
      '請先完成欄位：月租金'
    );
  });

  it('欄位齊全但簽署區不足時回報簽署區', () => {
    expect(sendBlockReason({ fields: fields(), signatureFields: [sig('party_b')] })).toBe(
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
    expect(resumeStepIndex(contract({ signature_fields: [sig('party_b')] }))).toBe(STEP_SIGNATURE);
  });

  it('欄位與簽署區都齊全回到第④步確認送簽', () => {
    expect(resumeStepIndex(contract())).toBe(STEP_CONFIRM);
  });
});

describe('stepStatuses（Steps 每一步的狀態）', () => {
  const ok = { fields: fields(), signatureFields: [sig('party_a'), sig('party_b')] };

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

describe('mergeEditableFields（第②步表單值併回草稿）', () => {
  const base = fields({
    templateId: 'residential-lease',
    templateVersion: 1,
    clauses: [{ id: 'pet', title: '寵物飼養', body: '（建約當時的條文）', version: 1 }],
  });
  const input = {
    landlordName: '林房東',
    landlordEmail: 'new-landlord@example.com',
    tenantName: '陳租客',
    tenantEmail: 'new-tenant@example.com',
    rent: 30000,
    deposit: 60000,
    startDate: '2026-10-01',
    endDate: '2027-09-30',
    payDay: 10,
    extra: '車位另計。',
  };

  it('表單欄位覆蓋草稿，其餘欄位原樣保留', () => {
    const merged = mergeEditableFields(base, input);
    expect(merged).toMatchObject(input);
    expect(merged.propertyName).toBe(base.propertyName);
    expect(merged.equipmentAnnex).toEqual(base.equipmentAnnex);
  });

  it('不動範本綁定與選用條款快照（第①步勾的條款不會被表單蓋掉）', () => {
    const merged = mergeEditableFields(base, input);
    expect(merged.templateVersion).toBe(1);
    expect(merged.clauses).toEqual(base.clauses);
  });

  it('沒填的欄位一律正規化成空字串或 null，不留 undefined', () => {
    expect(mergeEditableFields(base, {})).toMatchObject({
      landlordName: '',
      landlordEmail: '',
      tenantName: '',
      tenantEmail: '',
      rent: null,
      deposit: null,
      startDate: '',
      endDate: '',
      payDay: null,
      extra: '',
    });
  });
});

describe('upgradeDraftFields（草稿升版重建，ADR-0005 v1→v2）', () => {
  // v1 建立的草稿：範本 v1、設備只有壓平成字串的舊欄位
  const v1Draft = fields({
    templateId: 'residential-lease',
    templateVersion: 1,
    clauses: [{ id: 'pet', title: '寵物飼養', body: '（建約當時的條文）', version: 1 }],
    equipmentAnnex: undefined,
    equipment: ['冷氣 ×2', '洗衣機'],
  });

  it('綁上平台最新範本版本並重取已勾條款條文', () => {
    const upgraded = upgradeDraftFields(v1Draft);
    expect(upgraded.templateVersion).toBe(DEFAULT_TEMPLATE.version);
    expect(upgraded.clauses).toEqual([{ ...findClause('pet')! }]);
    expect(upgradeNotice(upgraded).hasUpgrade).toBe(false);
  });

  it('設備附件列從舊欄位轉出來：數量解析回來、修繕責任出租方、備註空', () => {
    expect(upgradeDraftFields(v1Draft).equipmentAnnex).toEqual([
      { name: '冷氣', quantity: 2, repair: 'landlord', note: '' },
      { name: '洗衣機', quantity: 1, repair: 'landlord', note: '' },
    ]);
  });

  it('轉出附件列後不再留著舊欄位', () => {
    expect(upgradeDraftFields(v1Draft).equipment).toBeUndefined();
  });

  it('已經有附件列的草稿升版時原樣保留逐約調整過的內容', () => {
    const tweaked = [{ name: '冷氣', quantity: 1, repair: 'tenant' as const, note: '房客自購' }];
    expect(upgradeDraftFields(fields({ equipmentAnnex: tweaked })).equipmentAnnex).toEqual(tweaked);
  });

  it('不就地改寫原本的草稿欄位', () => {
    upgradeDraftFields(v1Draft);
    expect(v1Draft.templateVersion).toBe(1);
    expect(v1Draft.equipmentAnnex).toBeUndefined();
    expect(v1Draft.equipment).toEqual(['冷氣 ×2', '洗衣機']);
  });
});
