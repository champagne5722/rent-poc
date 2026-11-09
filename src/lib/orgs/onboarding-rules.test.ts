import { describe, expect, it } from 'vitest';
import { landingPath, landingPathFor, validateOwnerForm, validatePracticeForm, type IdentityOption } from './onboarding-rules';

describe('validateOwnerForm', () => {
  it('名稱去掉前後空白後採用', () => {
    expect(validateOwnerForm({ name: '  王小明的屋主組織 ' })).toEqual({ ok: true, value: { name: '王小明的屋主組織' } });
  });

  it.each([[''], ['   '], [undefined], [42], ['a'.repeat(81)]])('名稱 %j 被拒', (name) => {
    expect(validateOwnerForm({ name })).toMatchObject({ ok: false, field: 'name' });
  });
});

const practice = (over: Record<string, unknown> = {}) => ({
  name: '安心代管有限公司',
  taxId: '12345678',
  entityType: 'company',
  kinds: ['management'],
  ...over,
});

describe('validatePracticeForm', () => {
  it('公司可以登錄代管、包租、經紀，兼營去重', () => {
    expect(validatePracticeForm(practice({ kinds: ['management', 'master_lease', 'management', 'brokerage'] }))).toEqual({
      ok: true,
      value: {
        name: '安心代管有限公司',
        taxId: '12345678',
        entityType: 'company',
        kinds: ['management', 'master_lease', 'brokerage'],
      },
    });
  });

  it('個體商號可以只登錄經紀', () => {
    expect(validatePracticeForm(practice({ entityType: 'firm', kinds: ['brokerage'] }))).toMatchObject({ ok: true });
  });

  it.each([['management'], ['master_lease']])('個體商號選 %s 被拒，說明租賃線限公司（company_required）', (kind) => {
    const result = validatePracticeForm(practice({ entityType: 'firm', kinds: [kind] }));
    expect(result).toMatchObject({ ok: false, field: 'kinds', code: 'company_required' });
    expect(result.ok ? '' : result.message).toContain('公司');
  });

  it('商號兼營經紀與代管時，仍因代管被拒；公司登錄代管時不因營業項目尚未登錄而被擋', () => {
    expect(validatePracticeForm(practice({ kinds: ['management'] }))).toMatchObject({ ok: true });
    expect(validatePracticeForm(practice({ entityType: 'firm', kinds: ['brokerage', 'management'] }))).toMatchObject({
      ok: false,
      code: 'company_required',
    });
  });

  it.each([['1234567'], ['123456789'], ['1234567a'], [12345678], [undefined]])('統編 %j 被拒', (taxId) => {
    expect(validatePracticeForm(practice({ taxId }))).toMatchObject({ ok: false, field: 'taxId' });
  });

  it('統編前後的空白去掉後採用', () => {
    expect(validatePracticeForm(practice({ taxId: ' 12345678\n' }))).toMatchObject({ ok: true, value: { taxId: '12345678' } });
  });

  it.each([[[]], [['unknown']], [undefined], ['management']])('業別 %j 被拒', (kinds) => {
    expect(validatePracticeForm(practice({ kinds }))).toMatchObject({ ok: false, field: 'kinds' });
  });

  it.each([['partnership'], [undefined]])('組織型態 %j 被拒', (entityType) => {
    expect(validatePracticeForm(practice({ entityType }))).toMatchObject({ ok: false, field: 'entityType' });
  });

  it('名稱不得為空', () => {
    expect(validatePracticeForm(practice({ name: ' ' }))).toMatchObject({ ok: false, field: 'name' });
  });
});

const owner = (orgId: string): IdentityOption => ({ identity: { kind: 'org', orgId }, kind: 'owner', label: orgId });
const practiceOrg = (orgId: string): IdentityOption => ({ identity: { kind: 'org', orgId }, kind: 'practice', label: orgId });
const operator: IdentityOption = { identity: { kind: 'operator' }, kind: 'operator', label: '平台營運者' };
const party: IdentityOption = { identity: { kind: 'party' }, kind: 'party', label: '承租人' };

describe('landingPath', () => {
  it('只有屋主身分的帳號落到 /owner', () => {
    expect(landingPath([owner('a')])).toBe('/owner');
    expect(landingPath([owner('a'), owner('b')])).toBe('/owner');
  });

  it('只有承租人身分的帳號落到 /tenant（MIL-121）', () => {
    expect(landingPath([party])).toBe('/tenant');
  });

  it.each([
    ['屋主加經理人', [owner('a'), practiceOrg('b')]],
    ['只有經理人', [practiceOrg('b')]],
    ['屋主加平台營運者', [owner('a'), operator]],
    ['屋主加承租人', [owner('a'), party]],
    ['經理人加承租人', [practiceOrg('b'), party]],
    ['承租人加平台營運者', [party, operator]],
    ['沒有任何身分', []],
  ])('%s 落到工作台', (_name, options) => {
    expect(landingPath(options)).toBe('/');
  });
});

describe('landingPathFor', () => {
  it('切到屋主組織落 /owner，承租人落 /tenant，其餘落工作台', () => {
    expect(landingPathFor(owner('a'))).toBe('/owner');
    expect(landingPathFor(practiceOrg('b'))).toBe('/');
    expect(landingPathFor(operator)).toBe('/');
    // MIL-121 改：原本承租人落工作台（'/'），承租人端建好後落 /tenant
    expect(landingPathFor(party)).toBe('/tenant');
  });
});
