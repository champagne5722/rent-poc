import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyContractAsDraft, ensureSchema, getContract, insertContractWithEvent, setDb } from './db';
import {
  DEFAULT_TEMPLATE,
  OPTIONAL_CLAUSES,
  bindTemplate,
  clauseSnapshots,
  findClause,
  upgradeNotice,
  upgradedTemplateBinding,
} from './clause-library';
import { buildContractClauses } from './contract-clauses';
import { upgradeDraftFields } from './contract-wizard';
import type { LeaseContract, LeaseContractFields, ContractStatus, OptionalClause } from './types';

// 快照落地測試（ADR-0005 §版本化＋建約即快照）：條款存進合約資料後，
// 平台條款庫怎麼改版都不能回頭改動既有合約與草稿。一律走 in-memory DB。

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  setDb(db);
});

afterEach(() => {
  setDb(null);
  db.close();
});

// 假裝平台把「寵物飼養」改版了
const BUMPED_LIBRARY: OptionalClause[] = OPTIONAL_CLAUSES.map((clause) =>
  clause.id === 'pet' ? { ...clause, version: clause.version + 1, body: '（改版後的寵物條款條文）' } : { ...clause }
);
const BUMPED_TEMPLATE = { ...DEFAULT_TEMPLATE, version: DEFAULT_TEMPLATE.version + 1 };
const BUMPED = { template: BUMPED_TEMPLATE, library: BUMPED_LIBRARY };

function contractFields(patch: Partial<LeaseContractFields> = {}): LeaseContractFields {
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
    ...bindTemplate(['pet']),
    ...patch,
  };
}

function seedDraft(fields: LeaseContractFields = contractFields()): LeaseContract {
  const id = insertContractWithEvent(
    { property_id: null, fields: JSON.stringify(fields) },
    { type: 'created', actor: 'landlord' }
  );
  return getContract(id) as LeaseContract;
}

/** 模擬 PUT /api/contracts/[id] 的草稿保存 */
function saveDraftFields(id: number, fields: LeaseContractFields): LeaseContract {
  db.prepare('UPDATE contracts SET fields = ? WHERE id = ?').run(JSON.stringify(fields), id);
  return getContract(id) as LeaseContract;
}

describe('建約時的範本綁定與條款快照', () => {
  it('合約存的是完整條文，不是條款 id', () => {
    const contract = seedDraft();
    expect(contract.fields.templateId).toBe(DEFAULT_TEMPLATE.id);
    expect(contract.fields.templateVersion).toBe(DEFAULT_TEMPLATE.version);
    expect(clauseSnapshots(contract.fields)).toEqual([{ ...findClause('pet')! }]);
  });

  it('平台條款改版不動既有草稿的快照，只是多了升版提示', () => {
    const contract = seedDraft();
    const reloaded = getContract(contract.id) as LeaseContract;
    expect(clauseSnapshots(reloaded.fields)[0].body).toBe(findClause('pet')!.body);
    expect(clauseSnapshots(reloaded.fields)[0].version).toBe(1);

    const notice = upgradeNotice(reloaded.fields, BUMPED);
    expect(notice.hasUpgrade).toBe(true);
    expect(notice.clauses.map((c) => c.id)).toEqual(['pet']);
  });

  it('平台條款改版不影響已送簽合約產出的條文', () => {
    const contract = seedDraft();
    db.prepare("UPDATE contracts SET status = 'awaiting_tenant' WHERE id = ?").run(contract.id);
    const sent = getContract(contract.id) as LeaseContract;
    const clauses = buildContractClauses(sent.fields);
    expect(clauses[7]).toEqual({ title: '第八條　寵物飼養', body: findClause('pet')!.body });
    expect(clauses[7].body).not.toContain('改版後');
  });

  it('沒勾任何條款的合約條款區維持九條', () => {
    const contract = seedDraft(contractFields(bindTemplate()));
    expect(buildContractClauses(contract.fields)).toHaveLength(9);
  });
});

describe('複製為新草稿', () => {
  it('沿用來源合約的快照，不會被平台當下的版本蓋掉', () => {
    const source = seedDraft();
    db.prepare("UPDATE contracts SET status = 'voided' WHERE id = ?").run(source.id);
    const voided = getContract(source.id) as LeaseContract;

    const copy = getContract(copyContractAsDraft(voided)) as LeaseContract;
    expect(copy.fields.templateVersion).toBe(source.fields.templateVersion);
    expect(clauseSnapshots(copy.fields)).toEqual(clauseSnapshots(source.fields));
    expect(upgradeNotice(copy.fields, BUMPED).hasUpgrade).toBe(true);
  });
});

describe('草稿升版重建', () => {
  it('升版後只有這份草稿重新快照，其他合約不受影響', () => {
    const other = seedDraft();
    const draft = seedDraft();

    const upgraded = saveDraftFields(draft.id, {
      ...draft.fields,
      ...upgradedTemplateBinding(draft.fields, BUMPED),
    });
    expect(upgraded.fields.templateVersion).toBe(BUMPED_TEMPLATE.version);
    expect(clauseSnapshots(upgraded.fields)[0].body).toBe('（改版後的寵物條款條文）');
    expect(upgradeNotice(upgraded.fields, BUMPED).hasUpgrade).toBe(false);

    const untouched = getContract(other.id) as LeaseContract;
    expect(clauseSnapshots(untouched.fields)[0].body).toBe(findClause('pet')!.body);
  });

  it('升版不強制：不升版的草稿照樣可以留著提示往下走', () => {
    const draft = seedDraft();
    const status: ContractStatus = (getContract(draft.id) as LeaseContract).status;
    expect(status).toBe('draft');
    expect(upgradeNotice(draft.fields, BUMPED).hasUpgrade).toBe(true);
    expect(clauseSnapshots(draft.fields)[0].version).toBe(1);
  });
});

// 範本 v1 → v2（MIL-29、ADR-0008）：第一次真的用到 ADR-0005 的草稿升版提示流程。
describe('範本 v1 草稿升到 v2', () => {
  /** MIL-29 之前建立的草稿：綁範本 v1，設備只有壓平成「名稱 ×數量」的字串 */
  function v1Fields(): LeaseContractFields {
    return contractFields({
      templateVersion: 1,
      equipmentAnnex: undefined,
      equipment: ['冷氣 ×2', '洗衣機'],
    });
  }

  it('v1 草稿看得到範本升版提示', () => {
    const draft = seedDraft(v1Fields());
    const notice = upgradeNotice(draft.fields);
    expect(notice.hasUpgrade).toBe(true);
    expect(notice.template).toEqual({ from: 1, to: DEFAULT_TEMPLATE.version });
  });

  it('不升版的 v1 草稿條文照舊在本文列舉設備', () => {
    const draft = seedDraft(v1Fields());
    const equipmentClause = buildContractClauses(draft.fields)[4];
    expect(equipmentClause.title).toBe('第五條　附屬設備');
    expect(equipmentClause.body).toContain('本房屋現有附屬設備如下：冷氣 ×2、洗衣機');
  });

  it('升版重建後綁 v2、設備附件列由舊欄位轉出、條文改為引用附件', () => {
    const other = seedDraft(v1Fields());
    const draft = seedDraft(v1Fields());

    const upgraded = saveDraftFields(draft.id, upgradeDraftFields(draft.fields));
    expect(upgraded.fields.templateVersion).toBe(DEFAULT_TEMPLATE.version);
    expect(upgraded.fields.equipmentAnnex).toEqual([
      { name: '冷氣', quantity: 2, repair: 'landlord', note: '' },
      { name: '洗衣機', quantity: 1, repair: 'landlord', note: '' },
    ]);
    expect(upgraded.fields.equipment).toBeUndefined();
    expect(buildContractClauses(upgraded.fields)[4].body).toContain('詳如附件');
    expect(upgradeNotice(upgraded.fields).hasUpgrade).toBe(false);

    // 其他 v1 合約不受影響
    const untouched = getContract(other.id) as LeaseContract;
    expect(untouched.fields.templateVersion).toBe(1);
    expect(buildContractClauses(untouched.fields)[4].body).toContain('本房屋現有附屬設備如下');
  });
});
