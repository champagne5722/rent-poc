import { describe, expect, it } from 'vitest';
import type { PropertyAnchor } from '@/lib/types';
import { anchorKeyText, anchorLocationText, anchorSummary, NO_KEY_TEXT } from './anchor-display';

const noKey: PropertyAnchor = {
  city_code: null,
  town_code: null,
  section_code: null,
  building_no: null,
  sub_no: null,
  city_name: null,
  town_name: null,
  section_name: null,
  latitude: null,
  longitude: null,
};
const withKey: PropertyAnchor = {
  ...noKey,
  city_code: 'A',
  town_code: '02',
  section_code: '0021',
  building_no: '01234',
  sub_no: '000',
  city_name: '臺北市',
  town_name: '大安區',
  section_name: '龍泉 一',
};

describe('建號的顯示文字', () => {
  it('有建號：縣市、鄉鎮市區、段小段加建號', () => {
    expect(anchorLocationText(withKey)).toBe('臺北市 大安區 龍泉 一');
    expect(anchorKeyText(withKey)).toBe('01234-000');
    expect(anchorSummary(withKey)).toBe('臺北市 大安區 龍泉 一 建號 01234-000');
  });

  it('沒有填建號的舊資料或讀不到：沒有行政區與建號可顯示', () => {
    expect(anchorLocationText(noKey)).toBeNull();
    expect(anchorKeyText(noKey)).toBeNull();
    expect(anchorSummary(noKey)).toBe(NO_KEY_TEXT);
    expect(anchorSummary(null)).toBe(NO_KEY_TEXT);
  });
});
