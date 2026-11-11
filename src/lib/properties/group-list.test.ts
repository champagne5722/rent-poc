import { describe, expect, it } from 'vitest';
import type { PropertyGroup, PropertyGroupUnit } from '@/lib/types';
import {
  archivedUnitCount,
  countGroupsByStatus,
  EMPTY_PROPERTY_LIST_FILTER,
  isPropertyListFilterActive,
  representativeUnit,
  selectPropertyGroups,
} from './group-list';

function unit(id: string, overrides: Partial<PropertyGroupUnit> = {}): PropertyGroupUnit {
  return {
    id,
    rental_unit_id: `ru-${id}`,
    unit: { suffix: '0000', label: null, floor: null, unit_type: 'whole', status: 'active', display_code: `F18-${id}` },
    archived_at: null,
    name: `物件 ${id}`,
    address: '台北市大安區和平東路二段 100 號 3 樓',
    type: '整層住家',
    size: null,
    default_rent: null,
    note: '',
    equipment: [],
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: null,
    ...overrides,
  };
}

function group(id: string, status: PropertyGroup['verification_status'], units: PropertyGroupUnit[], address = '台北市大安區和平東路二段 100 號 3 樓'): PropertyGroup {
  return { id, verification_status: status, anchor: null, address, units };
}

const sublet = (id: string, label: string, overrides: Partial<PropertyGroupUnit> = {}) =>
  unit(id, { name: `分租 ${label}`, unit: { suffix: '0001', label, floor: '3F', unit_type: 'sublet', status: 'active', display_code: `F18-${id}` }, ...overrides });

const groups = [
  group('A', 'verified', [unit('A'), sublet('A1', '301'), sublet('A2', '302', { archived_at: '2026-11-02T00:00:00.000Z' })]),
  group('B', 'pending_verification', [unit('B', { address: '新北市板橋區文化路一段 200 號 5 樓' })], '新北市板橋區文化路一段 200 號 5 樓'),
  group('C', 'failed', [unit('C', { archived_at: '2026-11-02T00:00:00.000Z' })], '高雄市前鎮區中山三路 1 號'),
];

describe('group-list', () => {
  it('代表單位是 id 與組相同的那一個，找不到時用第一個', () => {
    expect(representativeUnit(groups[0]!).id).toBe('A');
    expect(representativeUnit({ ...groups[0]!, id: 'X' }).id).toBe('A');
  });

  it('預設不列封存的單位，整個組都封存時整組不列', () => {
    const rows = selectPropertyGroups(groups, EMPTY_PROPERTY_LIST_FILTER);
    expect(rows.map((g) => g.id)).toEqual(['A', 'B']);
    expect(rows[0]!.units.map((u) => u.id)).toEqual(['A', 'A1']);
  });

  it('打開顯示已封存後，封存的單位與整組都列出', () => {
    const rows = selectPropertyGroups(groups, { ...EMPTY_PROPERTY_LIST_FILTER, showArchived: true });
    expect(rows.map((g) => g.id)).toEqual(['A', 'B', 'C']);
    expect(rows[0]!.units).toHaveLength(3);
  });

  it('依核對狀態篩選', () => {
    expect(selectPropertyGroups(groups, { ...EMPTY_PROPERTY_LIST_FILTER, status: 'pending_verification' }).map((g) => g.id)).toEqual(['B']);
  });

  it('關鍵字比對地址、單位名稱、房號與顯示編碼，不分大小寫與空白', () => {
    const search = (keyword: string) => selectPropertyGroups(groups, { ...EMPTY_PROPERTY_LIST_FILTER, keyword }).map((g) => g.id);
    expect(search('板橋')).toEqual(['B']);
    expect(search('分租 301')).toEqual(['A']);
    expect(search('f18-b')).toEqual(['B']);
    expect(search('  和平東路  ')).toEqual(['A']);
    expect(search('不存在')).toEqual([]);
  });

  it('關鍵字只命中組內某個單位時，仍列出整組的可見單位', () => {
    const rows = selectPropertyGroups(groups, { ...EMPTY_PROPERTY_LIST_FILTER, keyword: '301' });
    expect(rows[0]!.units.map((u) => u.id)).toEqual(['A', 'A1']);
  });

  it('各狀態筆數不受狀態篩選影響，但受封存與關鍵字影響', () => {
    expect(countGroupsByStatus(groups, EMPTY_PROPERTY_LIST_FILTER)).toEqual({ pending_verification: 1, verified: 1, failed: 0 });
    expect(countGroupsByStatus(groups, { ...EMPTY_PROPERTY_LIST_FILTER, showArchived: true })).toEqual({ pending_verification: 1, verified: 1, failed: 1 });
    expect(countGroupsByStatus(groups, { ...EMPTY_PROPERTY_LIST_FILTER, status: 'failed', keyword: '板橋' })).toEqual({ pending_verification: 1, verified: 0, failed: 0 });
  });

  it('封存單位數量算全部的組', () => {
    expect(archivedUnitCount(groups)).toBe(2);
  });

  it('有任何條件時篩選為啟用', () => {
    expect(isPropertyListFilterActive(EMPTY_PROPERTY_LIST_FILTER)).toBe(false);
    expect(isPropertyListFilterActive({ ...EMPTY_PROPERTY_LIST_FILTER, keyword: ' ' })).toBe(false);
    expect(isPropertyListFilterActive({ ...EMPTY_PROPERTY_LIST_FILTER, keyword: 'a' })).toBe(true);
    expect(isPropertyListFilterActive({ ...EMPTY_PROPERTY_LIST_FILTER, status: 'verified' })).toBe(true);
    expect(isPropertyListFilterActive({ ...EMPTY_PROPERTY_LIST_FILTER, showArchived: true })).toBe(true);
  });
});
