import { describe, expect, it } from 'vitest';
import { buildCaseLayers, type LayerCase } from './property-case-layers';

const c = (id: string, overrides: Partial<LayerCase> = {}): LayerCase => ({
  id,
  caseKind: 'lease',
  linkedMandateCaseId: null,
  linkedMasterLeaseCaseId: null,
  ...overrides,
});

describe('buildCaseLayers', () => {
  it('沒有案件回空陣列', () => {
    expect(buildCaseLayers([])).toEqual([]);
  });

  it('沒有連結的案件各自一層，沒有下層案件', () => {
    const layers = buildCaseLayers([c('A'), c('B', { caseKind: 'master_lease' })]);
    expect(layers.map((l) => [l.parent?.id, l.children.length])).toEqual([
      ['A', 0],
      ['B', 0],
    ]);
  });

  it('委託管理案件底下列出連到它的租賃案件', () => {
    const layers = buildCaseLayers([c('M', { caseKind: 'management' }), c('L1', { linkedMandateCaseId: 'M' }), c('L2', { linkedMandateCaseId: 'M' })]);
    expect(layers).toHaveLength(1);
    expect(layers[0]!.parent?.id).toBe('M');
    expect(layers[0]!.children.map((x) => x.id)).toEqual(['L1', 'L2']);
  });

  it('包租案件底下列出轉租案件', () => {
    const layers = buildCaseLayers([c('P', { caseKind: 'master_lease' }), c('S', { caseKind: 'sublease', linkedMasterLeaseCaseId: 'P' })]);
    expect(layers[0]!.children.map((x) => x.id)).toEqual(['S']);
  });

  it('上層案件不在這個物件的案件裡時，下層案件掛在只有 ID 的上層，依上層種類分組', () => {
    const layers = buildCaseLayers([c('L1', { linkedMandateCaseId: 'M' }), c('L2', { linkedMandateCaseId: 'M' }), c('S', { caseKind: 'sublease', linkedMasterLeaseCaseId: 'P' })]);
    expect(layers.map((l) => [l.parent, l.parentId, l.parentKind, l.children.map((x) => x.id)])).toEqual([
      [null, 'M', 'management', ['L1', 'L2']],
      [null, 'P', 'master_lease', ['S']],
    ]);
  });
});
