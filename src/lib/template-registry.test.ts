import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE, OPTIONAL_CLAUSES } from './clause-library';
import {
  boundTemplateOf,
  currentTemplate,
  isLegalReviewed,
  optionalClausesFor,
  templatesFor,
} from './template-registry';

// 範本登錄（MIL-73）：範本依合約類型查詢，法務審閱旗標在範本登錄，不在合約上。

describe('範本依合約類型查詢', () => {
  it('租賃合約的範本是住宅租賃契約 v2，版本與名稱不變', () => {
    const template = currentTemplate('lease');
    expect(template).toMatchObject({ id: 'residential-lease', name: '住宅租賃契約', version: 2 });
    expect(template).toBe(DEFAULT_TEMPLATE);
    expect(templatesFor('lease')).toEqual([DEFAULT_TEMPLATE]);
  });

  it('租賃合約的選用條款庫是原本那四條', () => {
    expect(optionalClausesFor('lease').map((c) => c.id)).toEqual(['pet', 'sublet', 'early-exit', 'utilities']);
    expect(optionalClausesFor('lease')).toBe(OPTIONAL_CLAUSES);
  });

  it('委託管理合約的範本是委託管理契約 v1，簡化示意條文，沒有選用條款', () => {
    expect(currentTemplate('management')).toMatchObject({
      id: 'management-agreement',
      name: '委託管理契約',
      version: 1,
      legalReviewed: false,
    });
    expect(templatesFor('management')).toHaveLength(1);
    expect(optionalClausesFor('management')).toEqual([]);
  });
});

describe('合約綁定的範本版本', () => {
  it('依合約綁的 templateId 與 templateVersion 找到登錄的範本', () => {
    expect(boundTemplateOf('lease', { templateId: 'residential-lease', templateVersion: 2 })).toBe(DEFAULT_TEMPLATE);
  });

  it('登錄查不到的版本回 null：早期沒綁版本的草稿、已不在登錄的舊版', () => {
    expect(boundTemplateOf('lease', {})).toBeNull();
    expect(boundTemplateOf('lease', { templateId: 'residential-lease', templateVersion: 1 })).toBeNull();
    expect(boundTemplateOf('lease', { templateId: 'other', templateVersion: 2 })).toBeNull();
  });

  it('不同合約類型不互相借用範本', () => {
    expect(boundTemplateOf('management', { templateId: 'residential-lease', templateVersion: 2 })).toBeNull();
  });
});

describe('法務審閱旗標', () => {
  it('現有租賃範本是未審閱', () => {
    expect(DEFAULT_TEMPLATE.legalReviewed).toBe(false);
    expect(isLegalReviewed('lease', { templateId: 'residential-lease', templateVersion: 2 })).toBe(false);
  });

  it('查不到範本一律視為未審閱', () => {
    expect(isLegalReviewed('lease', {})).toBe(false);
    expect(isLegalReviewed('management', {})).toBe(false);
  });
});

describe('審閱過的範本', () => {
  const reviewed = {
    lease: [{ ...DEFAULT_TEMPLATE, legalReviewed: true }],
    management: [],
    master_lease: [],
    sublease: [],
  };

  it('旗標為 true 的範本，綁定它的合約算已審閱', () => {
    expect(isLegalReviewed('lease', { templateId: 'residential-lease', templateVersion: 2 }, reviewed)).toBe(true);
  });

  it('審閱的是登錄的那個版本，不外溢到別的版本', () => {
    expect(isLegalReviewed('lease', { templateId: 'residential-lease', templateVersion: 1 }, reviewed)).toBe(false);
  });
});
