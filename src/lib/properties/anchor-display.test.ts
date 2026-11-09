import { describe, expect, it } from 'vitest';
import type { PropertyAnchor } from '@/lib/types';
import { ANCHOR_STATUS_LABELS, anchorKeyText, anchorLocationText, anchorSummary } from './anchor-display';

const pending: PropertyAnchor = {
  status: 'pending_verification',
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
const keyed: PropertyAnchor = {
  ...pending,
  status: 'keyed',
  city_code: 'A',
  town_code: '02',
  section_code: '0021',
  building_no: '01234',
  sub_no: '000',
  city_name: '臺北市',
  town_name: '大安區',
  section_name: '龍泉 一',
};

describe('產權的顯示文字', () => {
  it('狀態標籤用繁體中文', () => {
    expect(ANCHOR_STATUS_LABELS).toEqual({
      pending_verification: '待驗證',
      keyed: '已建號',
      merged: '已合併',
      retired: '已停用',
    });
  });

  it('已建號：縣市、鄉鎮市區、段小段加建號', () => {
    expect(anchorLocationText(keyed)).toBe('臺北市 大安區 龍泉 一');
    expect(anchorKeyText(keyed)).toBe('01234-000');
    expect(anchorSummary(keyed)).toBe('臺北市 大安區 龍泉 一 建號 01234-000');
  });

  it('待驗證或讀不到：沒有行政區與建號可顯示', () => {
    expect(anchorLocationText(pending)).toBeNull();
    expect(anchorKeyText(pending)).toBeNull();
    expect(anchorSummary(pending)).toBe('待驗證');
    expect(anchorSummary(null)).toBe('待驗證');
  });
});
