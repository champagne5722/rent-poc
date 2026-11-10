import { describe, expect, it } from 'vitest';
import type { MandateItem } from '../mandate-schedule';
import type { ContractFields, LeaseContractFields, ManagementContractFields, Property } from '../types';
import {
  CONTRACT_TYPES,
  contractTypeDefinition,
  initialFieldsFor,
  listSummaryOf,
  mergeManagementFields,
  missingFieldsOf,
  partyOf,
  withParty,
} from './index';

// 合約類型定義（MIL-73）：欄位、範本與檢核由類型決定，共用流程只經這個介面取用。

const PROPERTY: Property = {
  id: '01HZ0000000000000000000007',
  rental_unit_id: '01HZ0000000000000000000008',
  unit: null,
  archived_at: null,
  anchor: null,
  verification_status: 'pending_verification',
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

const LEASE_FIELDS: LeaseContractFields = {
  landlordName: '王大明',
  landlordEmail: 'landlord@example.com',
  tenantName: '李小華',
  tenantEmail: 'tenant@example.com',
  propertyName: '信義小宅',
  propertyAddress: '台北市信義區松仁路 1 號',
  propertyType: '套房',
  propertySize: 12.5,
  rent: 18000,
  deposit: 36000,
  startDate: '2026-12-01',
  endDate: '2027-11-30',
  payDay: 5,
  extra: '',
};

const MANAGEMENT_FIELDS: ManagementContractFields = {
  mandatorName: '陳屋主',
  mandatorEmail: 'owner@example.com',
  mandataryName: '北辰管理',
  mandataryEmail: 'manager@example.com',
  termStart: '2027-01-01',
  termEnd: '2027-12-31',
  feeMode: 'monthly_fixed',
  feeValue: 3000,
  extra: '',
};

const MANDATE_ITEMS: MandateItem[] = [
  { propertyId: '7', propertyName: '信義小宅', propertyAddress: '台北市信義區松仁路 1 號', scopes: ['rent_collection'] },
];

describe('合約類型登錄', () => {
  it('每個合約類型都有定義，沒有漏的', () => {
    expect([...CONTRACT_TYPES].sort()).toEqual(['lease', 'management']);
    for (const type of CONTRACT_TYPES) expect(contractTypeDefinition(type).type).toBe(type);
  });

  it('稱謂依合約類型：租賃是出租人與承租人，委託管理是委託人與受託人', () => {
    expect(contractTypeDefinition('lease').labels).toMatchObject({ partyAFull: '甲方（出租人）', partyBFull: '乙方（承租人）' });
    expect(contractTypeDefinition('management').labels).toMatchObject({ partyAFull: '甲方（委託人）', partyBFull: '乙方（受託人）' });
  });

  it('文件名稱依合約類型，租賃合約維持原本的「租賃合約」', () => {
    expect(contractTypeDefinition('lease').documentName).toBe('租賃合約');
    expect(contractTypeDefinition('management').documentName).toBe('委託管理合約');
  });
});

describe('依合約類型取當事人', () => {
  it('租賃合約：甲方是出租人，乙方是承租人', () => {
    const contract = { contract_type: 'lease', fields: LEASE_FIELDS } as const;
    expect(partyOf(contract, 'party_a')).toEqual({ name: '王大明', email: 'landlord@example.com' });
    expect(partyOf(contract, 'party_b')).toEqual({ name: '李小華', email: 'tenant@example.com' });
  });

  it('委託管理合約：甲方是委託人，乙方是受託人', () => {
    const contract = { contract_type: 'management', fields: MANAGEMENT_FIELDS } as const;
    expect(partyOf(contract, 'party_a')).toEqual({ name: '陳屋主', email: 'owner@example.com' });
    expect(partyOf(contract, 'party_b')).toEqual({ name: '北辰管理', email: 'manager@example.com' });
  });

  it('withParty 回傳新物件寫入那一方，不改動原物件', () => {
    const signer = { name: '李淑芬', email: 'li@beichen.example.com' };
    const lease = withParty({ contract_type: 'lease', fields: LEASE_FIELDS }, 'party_a', signer);
    expect(lease).toMatchObject({ landlordName: '李淑芬', landlordEmail: 'li@beichen.example.com', tenantName: '李小華' });
    expect(LEASE_FIELDS.landlordName).toBe('王大明');

    const management = withParty({ contract_type: 'management', fields: MANAGEMENT_FIELDS }, 'party_b', signer);
    expect(management).toMatchObject({ mandataryName: '李淑芬', mandataryEmail: 'li@beichen.example.com', mandatorName: '陳屋主' });
  });
});

describe('依合約類型檢核必填欄位', () => {
  it('租賃合約沿用原本的缺漏標籤', () => {
    expect(missingFieldsOf({ contract_type: 'lease', fields: LEASE_FIELDS })).toEqual([]);
    expect(
      missingFieldsOf({ contract_type: 'lease', fields: { ...LEASE_FIELDS, landlordName: ' ', rent: null } }),
    ).toEqual(['甲方姓名', '月租金']);
  });

  it('委託管理合約檢核兩方當事人，標籤用委託人與受託人', () => {
    expect(missingFieldsOf({ contract_type: 'management', fields: MANAGEMENT_FIELDS })).toEqual([]);
    expect(
      missingFieldsOf({
        contract_type: 'management',
        fields: { ...MANAGEMENT_FIELDS, mandatorName: '', mandataryEmail: 'bad' },
      }),
    ).toEqual(['委託人姓名', '受託人 Email']);
  });

  it('委託管理合約檢核委託期間與報酬約定', () => {
    const blank = { ...MANAGEMENT_FIELDS, termStart: '', termEnd: '', feeMode: null, feeValue: null };
    expect(missingFieldsOf({ contract_type: 'management', fields: blank })).toEqual([
      '委託期間起日',
      '委託期間迄日',
      '報酬約定',
    ]);
    expect(
      missingFieldsOf({ contract_type: 'management', fields: { ...MANAGEMENT_FIELDS, termEnd: '2026-12-31' } }),
    ).toEqual(['委託期間迄日（不得早於起日）']);
    expect(
      missingFieldsOf({ contract_type: 'management', fields: { ...MANAGEMENT_FIELDS, feeValue: null } }),
    ).toEqual(['報酬金額']);
  });

  it('報酬是租金百分比時，數值要在 0 到 100 之間', () => {
    const percent = { ...MANAGEMENT_FIELDS, feeMode: 'rent_percentage' as const };
    expect(missingFieldsOf({ contract_type: 'management', fields: { ...percent, feeValue: 8 } })).toEqual([]);
    expect(missingFieldsOf({ contract_type: 'management', fields: { ...percent, feeValue: 120 } })).toEqual([
      '報酬金額（百分比要在 0 到 100 之間）',
    ]);
  });

  it('帶委託標的清單時，清單有問題就列為缺漏；沒帶清單時不檢查', () => {
    const contract = { contract_type: 'management', fields: MANAGEMENT_FIELDS } as const;
    expect(missingFieldsOf(contract, { mandateItems: MANDATE_ITEMS })).toEqual([]);
    expect(missingFieldsOf(contract, { mandateItems: [] })).toEqual(['委託標的清單']);
    expect(missingFieldsOf(contract, { mandateItems: [{ ...MANDATE_ITEMS[0], scopes: [] }] })).toEqual(['委託標的清單']);
    expect(missingFieldsOf(contract)).toEqual([]);
  });

  it('租賃合約不看委託標的清單', () => {
    expect(missingFieldsOf({ contract_type: 'lease', fields: LEASE_FIELDS }, { mandateItems: [] })).toEqual([]);
  });
});

describe('是否需要物件、建約入口的說明', () => {
  it('租賃合約從物件建立，委託管理合約不需要物件而且有說明', () => {
    expect(contractTypeDefinition('lease').requiresProperty).toBe(true);
    expect(contractTypeDefinition('lease').draftNotice).toBeUndefined();
    expect(contractTypeDefinition('management').requiresProperty).toBe(false);
    expect(contractTypeDefinition('management').draftNotice?.title).toBe('委託管理合約不綁單一物件');
  });
});

describe('是否支援送簽', () => {
  it('租賃合約支援，委託管理合約的送簽屬 MIL-77，目前不支援', () => {
    expect(contractTypeDefinition('lease').sendSupported).toBe(true);
    expect(contractTypeDefinition('management').sendSupported).toBe(false);
  });
});

describe('依合約類型建立草稿欄位', () => {
  it('租賃合約：物件快照、設備附件、預設押金兩個月、範本 v2 綁定', () => {
    const fields = initialFieldsFor('lease', { property: PROPERTY });
    expect(fields).toEqual({
      landlordName: '',
      landlordEmail: '',
      tenantName: '',
      tenantEmail: '',
      propertyName: '信義小宅',
      propertyAddress: '台北市信義區松仁路 1 號',
      propertyType: '套房',
      propertySize: 12.5,
      equipmentAnnex: [
        { name: '冷氣', quantity: 2, repair: 'landlord', note: '' },
        { name: '冰箱', quantity: 1, repair: 'landlord', note: '' },
      ],
      rent: 18000,
      deposit: 36000,
      startDate: '',
      endDate: '',
      payDay: 5,
      extra: '',
      templateId: 'residential-lease',
      templateVersion: 2,
      clauses: [],
    });
  });

  it('租賃合約：帶入分流條件', () => {
    const routing = { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: true } as const;
    expect(initialFieldsFor('lease', { property: PROPERTY, routing })).toMatchObject({ routing });
  });

  it('租賃合約：物件沒有預設租金時租金與押金都是 null', () => {
    expect(initialFieldsFor('lease', { property: { ...PROPERTY, default_rent: null } })).toMatchObject({
      rent: null,
      deposit: null,
    });
  });

  it('委託管理合約：空白的兩方當事人、委託期間與報酬，綁定範本 v1，沒有選用條款', () => {
    expect(initialFieldsFor('management', {})).toEqual({
      mandatorName: '',
      mandatorEmail: '',
      mandataryName: '',
      mandataryEmail: '',
      termStart: '',
      termEnd: '',
      feeMode: null,
      feeValue: null,
      extra: '',
      templateId: 'management-agreement',
      templateVersion: 1,
      clauses: [],
    });
  });

  it('租賃合約沒有物件時拒絕建立', () => {
    expect(() => initialFieldsFor('lease', {})).toThrow('租賃合約需要物件');
  });
});

describe('清單用的摘要', () => {
  it('租賃合約：物件名稱、乙方、租期', () => {
    expect(listSummaryOf({ contract_type: 'lease', fields: LEASE_FIELDS })).toEqual({
      propertyName: '信義小宅',
      rent: 18000,
      partyB: { name: '李小華', email: 'tenant@example.com' },
      period: ['2026-12-01', '2027-11-30'],
    });
  });

  it('租賃合約租期沒填完時沒有租期', () => {
    expect(listSummaryOf({ contract_type: 'lease', fields: { ...LEASE_FIELDS, endDate: '' } }).period).toBeNull();
  });

  it('委託管理合約：沒有單一物件與租金，乙方是受託人，期間是委託期間', () => {
    expect(listSummaryOf({ contract_type: 'management', fields: MANAGEMENT_FIELDS })).toEqual({
      propertyName: null,
      rent: null,
      partyB: { name: '北辰管理', email: 'manager@example.com' },
      period: ['2027-01-01', '2027-12-31'],
    });
  });

  it('委託管理合約委託期間沒填完時沒有期間', () => {
    expect(listSummaryOf({ contract_type: 'management', fields: { ...MANAGEMENT_FIELDS, termEnd: '' } }).period).toBeNull();
  });
});

describe('欄位形狀', () => {
  it('聯集成員都滿足 ContractFields', () => {
    const all: ContractFields[] = [LEASE_FIELDS, MANAGEMENT_FIELDS];
    expect(all).toHaveLength(2);
  });
});

describe('委託管理合約：第②步表單的值併回欄位', () => {
  it('只覆蓋表單管的欄位，範本綁定與分流條件原樣留著', () => {
    const base = { ...MANAGEMENT_FIELDS, templateId: 'management-agreement', templateVersion: 1, clauses: [] };
    const merged = mergeManagementFields(base, {
      mandatorName: '新屋主',
      mandatorEmail: 'new@example.com',
      termStart: '2028-01-01',
      termEnd: '2028-12-31',
      feeMode: 'rent_percentage',
      feeValue: 8,
    });
    expect(merged).toMatchObject({
      mandatorName: '新屋主',
      termStart: '2028-01-01',
      feeMode: 'rent_percentage',
      feeValue: 8,
      templateId: 'management-agreement',
      templateVersion: 1,
    });
    // 受託人兩欄表單沒給（由當事人簽署人帶入），沿用底稿的值，不被清空
    expect(merged.mandataryName).toBe('北辰管理');
  });

  it('沒填的欄位正規化成空字串或 null，不讓 undefined 進資料庫', () => {
    const merged = mergeManagementFields(MANAGEMENT_FIELDS, {});
    expect(merged).toMatchObject({
      mandatorName: '',
      mandatorEmail: '',
      termStart: '',
      termEnd: '',
      feeMode: null,
      feeValue: null,
      extra: '',
    });
    expect(Object.values(merged)).not.toContain(undefined);
  });
});
