import { describe, expect, it } from 'vitest';
import { PROPERTY_NOT_VERIFIED_CODE } from './ownership/gate';
import { createCaseLabel, creationBlockedNext, newCaseHref, orderedCaseKinds, parseNewCaseParams } from './property-case-entry';

const ID = '01JD3X7Z5K8M2N4P6Q8R0S2T4V';

describe('newCaseHref 與 parseNewCaseParams', () => {
  it('組出的網址能被解析回原本的參數', () => {
    for (const kind of ['lease', 'master_lease', 'sublease'] as const) {
      const href = newCaseHref(ID, kind);
      expect(href).toBe(`/contracts/new?property=${ID}&kind=${kind}`);
      const query = new URL(href, 'http://localhost').searchParams;
      expect(parseNewCaseParams({ property: query.get('property') ?? undefined, kind: query.get('kind') ?? undefined })).toEqual({
        propertyId: ID,
        kind,
      });
    }
  });

  it('沒帶參數回 null', () => {
    expect(parseNewCaseParams({})).toBeNull();
    expect(parseNewCaseParams({ property: ID })).toBeNull();
    expect(parseNewCaseParams({ kind: 'lease' })).toBeNull();
  });

  it('物件 ID 格式錯誤回 null', () => {
    expect(parseNewCaseParams({ property: 'not-a-ulid', kind: 'lease' })).toBeNull();
    expect(parseNewCaseParams({ property: '', kind: 'lease' })).toBeNull();
  });

  it('案件種類不認得回 null，含委託管理案件（它不綁單一物件）', () => {
    expect(parseNewCaseParams({ property: ID, kind: 'management' })).toBeNull();
    expect(parseNewCaseParams({ property: ID, kind: 'unknown' })).toBeNull();
    expect(parseNewCaseParams({ property: ID, kind: '' })).toBeNull();
  });

  it('參數重複時取第一個', () => {
    expect(parseNewCaseParams({ property: [ID, 'x'], kind: ['sublease', 'lease'] })).toEqual({ propertyId: ID, kind: 'sublease' });
  });
});

describe('createCaseLabel', () => {
  it('用案件種類的法定名稱', () => {
    expect(createCaseLabel('lease')).toBe('建立租賃案件');
    expect(createCaseLabel('master_lease')).toBe('建立包租案件');
    expect(createCaseLabel('sublease')).toBe('建立轉租案件');
  });
});

describe('orderedCaseKinds', () => {
  it('依租賃、包租、轉租的固定順序，忽略不認得的值', () => {
    expect(orderedCaseKinds(['sublease', 'lease'])).toEqual(['lease', 'sublease']);
    expect(orderedCaseKinds([])).toEqual([]);
  });
});

describe('creationBlockedNext', () => {
  it('未核對連到物件詳情', () => {
    expect(creationBlockedNext(PROPERTY_NOT_VERIFIED_CODE, ID)).toEqual({ href: `/properties/${ID}`, label: '查看物件的核對狀態' });
  });

  it('沒有可簽章的專任管理人員連到執業主體頁', () => {
    expect(creationBlockedNext('no_signable_manager', ID).href).toBe('/practice');
    expect(creationBlockedNext('practice_entity_not_verified', ID).href).toBe('/practice');
  });

  it('組織種類不符回物件列表', () => {
    expect(creationBlockedNext('host_org_not_allowed', ID).href).toBe('/properties');
  });

  it('沒有碼或不認得的碼，回到這個物件的詳情', () => {
    expect(creationBlockedNext(undefined, ID).href).toBe(`/properties/${ID}`);
    expect(creationBlockedNext('no_valid_master_lease', ID).href).toBe(`/properties/${ID}`);
  });

  it('連結文字不含錯誤碼', () => {
    for (const code of [PROPERTY_NOT_VERIFIED_CODE, 'no_signable_manager', 'host_org_not_allowed', 'no_valid_master_lease', undefined]) {
      expect(creationBlockedNext(code, ID).label).not.toMatch(/[a-z]+_[a-z_]+/);
    }
  });
});
