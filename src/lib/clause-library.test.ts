import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATE,
  OPTIONAL_CLAUSES,
  bindTemplate,
  clauseSnapshots,
  findClause,
  reselectClauses,
  selectedClauseIds,
  snapshotClauses,
  templateLabel,
  upgradeNotice,
  upgradedTemplateBinding,
} from './clause-library';
import type { OptionalClause, TemplateBinding } from './types';

// 改版後的假條款庫：測「平台條款改版不影響既有合約與草稿」時用它扮演新版平台資料
const BUMPED: OptionalClause[] = OPTIONAL_CLAUSES.map((c) =>
  c.id === 'pet' ? { ...c, version: c.version + 1, body: '（改版後的寵物條款條文）' } : { ...c }
);
const BUMPED_TEMPLATE = { ...DEFAULT_TEMPLATE, version: DEFAULT_TEMPLATE.version + 1 };

describe('選用條款庫（平台資料）', () => {
  it('提供 3〜5 條，每條都有 id、標題、條文與版本', () => {
    expect(OPTIONAL_CLAUSES.length).toBeGreaterThanOrEqual(3);
    expect(OPTIONAL_CLAUSES.length).toBeLessThanOrEqual(5);
    for (const clause of OPTIONAL_CLAUSES) {
      expect(clause.id).toMatch(/^[a-z-]+$/);
      expect(clause.title.length).toBeGreaterThan(0);
      expect(clause.body.length).toBeGreaterThan(10);
      expect(clause.version).toBeGreaterThanOrEqual(1);
    }
  });

  it('id 不重複', () => {
    expect(new Set(OPTIONAL_CLAUSES.map((c) => c.id)).size).toBe(OPTIONAL_CLAUSES.length);
  });

  it('findClause 查得到既有條款、查不到就回 null', () => {
    expect(findClause('pet')?.title).toBe('寵物飼養');
    expect(findClause('not-exist')).toBeNull();
  });
});

describe('snapshotClauses', () => {
  it('把勾選的 id 換成完整條文快照（含版本），順序照條款庫', () => {
    const snapshots = snapshotClauses(['utilities', 'pet']);
    expect(snapshots.map((c) => c.id)).toEqual(['pet', 'utilities']);
    expect(snapshots[0]).toEqual({
      id: 'pet',
      title: findClause('pet')!.title,
      body: findClause('pet')!.body,
      version: findClause('pet')!.version,
    });
  });

  it('忽略不存在的 id，重複 id 只留一份', () => {
    expect(snapshotClauses(['pet', 'pet', 'ghost']).map((c) => c.id)).toEqual(['pet']);
  });

  it('沒勾就是空陣列', () => {
    expect(snapshotClauses([])).toEqual([]);
  });
});

describe('bindTemplate（建約時綁定範本版本）', () => {
  it('綁定當下的範本 id 與版本，條款預設空白', () => {
    expect(bindTemplate()).toEqual({
      templateId: DEFAULT_TEMPLATE.id,
      templateVersion: DEFAULT_TEMPLATE.version,
      clauses: [],
    });
  });

  it('可一併帶入勾選條款的快照', () => {
    expect(bindTemplate(['sublet']).clauses.map((c) => c.id)).toEqual(['sublet']);
  });
});

describe('clauseSnapshots / selectedClauseIds', () => {
  it('沒有 clauses 欄位的舊資料一律當成沒勾', () => {
    expect(clauseSnapshots({})).toEqual([]);
    expect(selectedClauseIds({})).toEqual([]);
  });

  it('讀得到合約自己的快照，不回頭查平台條款庫', () => {
    const binding: TemplateBinding = {
      clauses: [{ id: 'pet', title: '舊版寵物飼養', body: '舊版條文', version: 1 }],
    };
    expect(clauseSnapshots(binding)[0].body).toBe('舊版條文');
    expect(selectedClauseIds(binding)).toEqual(['pet']);
  });
});

describe('reselectClauses（wizard 改勾選）', () => {
  const bound = bindTemplate(['pet']);

  it('新勾的條款取平台當下條文，順序照條款庫', () => {
    const clauses = reselectClauses(bound, ['pet', 'sublet']);
    expect(clauses.map((c) => c.id)).toEqual(['pet', 'sublet']);
    expect(clauses[1]).toEqual({ ...findClause('sublet')! });
  });

  it('取消勾選就從快照移除', () => {
    expect(reselectClauses(bound, []).map((c) => c.id)).toEqual([]);
  });

  it('改勾別條不會把已勾條款偷偷升版', () => {
    const clauses = reselectClauses(bound, ['pet', 'utilities'], BUMPED);
    expect(clauses[0]).toEqual({ ...findClause('pet')! }); // 仍是草稿當初的 v1 條文
    expect(clauses[1].version).toBe(findClause('utilities')!.version);
  });

  it('仍勾著的下架條款原樣保留在最後', () => {
    const retired = { id: 'retired', title: '已下架條款', body: '舊條文', version: 3 };
    const binding: TemplateBinding = { ...bindTemplate(), clauses: [retired] };
    expect(reselectClauses(binding, ['retired', 'sublet'])).toEqual([{ ...findClause('sublet')! }, retired]);
  });
});

describe('upgradeNotice（草稿遇新版的升版提示）', () => {
  const bound = bindTemplate(['pet', 'sublet']);

  it('綁的就是當下版本時沒有任何提示', () => {
    expect(upgradeNotice(bound)).toEqual({ template: null, clauses: [], hasUpgrade: false });
  });

  it('條款改版時只點名該條，並帶新舊版號', () => {
    const notice = upgradeNotice(bound, { library: BUMPED });
    expect(notice.hasUpgrade).toBe(true);
    expect(notice.template).toBeNull();
    expect(notice.clauses).toEqual([{ id: 'pet', title: '寵物飼養', from: 1, to: 2 }]);
  });

  it('範本改版時點名範本', () => {
    const notice = upgradeNotice(bound, { template: BUMPED_TEMPLATE });
    expect(notice.hasUpgrade).toBe(true);
    expect(notice.template).toEqual({ from: DEFAULT_TEMPLATE.version, to: BUMPED_TEMPLATE.version });
  });

  it('沒勾的條款改版不會提示', () => {
    expect(upgradeNotice(bindTemplate(['sublet']), { library: BUMPED }).hasUpgrade).toBe(false);
  });

  it('條款從平台下架時不提示升版（快照照舊留在合約裡）', () => {
    const binding: TemplateBinding = {
      ...bindTemplate(),
      clauses: [{ id: 'retired', title: '已下架條款', body: '舊條文', version: 3 }],
    };
    expect(upgradeNotice(binding).hasUpgrade).toBe(false);
  });

  it('早期沒綁範本的合約視為舊版，提示可升版', () => {
    const notice = upgradeNotice({});
    expect(notice.hasUpgrade).toBe(true);
    expect(notice.template).toEqual({ from: 0, to: DEFAULT_TEMPLATE.version });
  });
});

describe('upgradedTemplateBinding（升版＝重新快照）', () => {
  const bound = bindTemplate(['pet', 'sublet']);

  it('重新綁最新範本版本並重取已勾條款的最新條文', () => {
    const upgraded = upgradedTemplateBinding(bound, { template: BUMPED_TEMPLATE, library: BUMPED });
    expect(upgraded.templateVersion).toBe(BUMPED_TEMPLATE.version);
    expect(upgraded.clauses.map((c) => c.id)).toEqual(['pet', 'sublet']);
    expect(upgraded.clauses[0]).toMatchObject({ version: 2, body: '（改版後的寵物條款條文）' });
    expect(upgraded.clauses[1]).toEqual(bound.clauses[1]);
  });

  it('升版不動原本的快照物件（既有合約資料不被就地改寫）', () => {
    upgradedTemplateBinding(bound, { template: BUMPED_TEMPLATE, library: BUMPED });
    expect(bound.clauses[0].body).toBe(findClause('pet')!.body);
    expect(bound.templateVersion).toBe(DEFAULT_TEMPLATE.version);
  });

  it('已下架的條款原樣保留', () => {
    const retired = { id: 'retired', title: '已下架條款', body: '舊條文', version: 3 };
    const upgraded = upgradedTemplateBinding({ ...bindTemplate(), clauses: [retired] });
    expect(upgraded.clauses).toEqual([retired]);
  });

  it('升版後就沒有升版提示了', () => {
    const upgraded = upgradedTemplateBinding(bound, { template: BUMPED_TEMPLATE, library: BUMPED });
    expect(upgradeNotice(upgraded, { template: BUMPED_TEMPLATE, library: BUMPED }).hasUpgrade).toBe(false);
  });
});

describe('templateLabel', () => {
  it('顯示合約當初綁的版本，不是平台當下的版本', () => {
    expect(templateLabel(bindTemplate())).toBe(`${DEFAULT_TEMPLATE.name} v${DEFAULT_TEMPLATE.version}`);
    expect(templateLabel({ templateId: DEFAULT_TEMPLATE.id, templateVersion: 7 })).toBe(
      `${DEFAULT_TEMPLATE.name} v7`
    );
  });

  it('早期沒綁範本的合約顯示為未綁定版本', () => {
    expect(templateLabel({})).toBe(`${DEFAULT_TEMPLATE.name}（未綁定版本）`);
  });
});
