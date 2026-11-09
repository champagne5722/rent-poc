import { describe, expect, it } from 'vitest';
import { buildAnchorPayload } from './anchor-form';

describe('buildAnchorPayload（產權表單 → API 欄位）', () => {
  const key = { city: 'A', town: '02', section: '0021', buildingNo: ' 1234 ', subNo: '' };

  it('有填鍵：送鍵，建號前後空白去掉，座標沒填送 null', () => {
    expect(buildAnchorPayload({ noKey: false, key })).toEqual({
      key: { city: 'A', town: '02', section: '0021', buildingNo: '1234', subNo: '' },
      latitude: null,
      longitude: null,
    });
  });

  it('勾「暫無建號」：不送鍵，即使表單裡還留著之前填的值', () => {
    expect(buildAnchorPayload({ noKey: true, key, latitude: 25.03, longitude: 121.56 })).toEqual({
      key: null,
      latitude: 25.03,
      longitude: 121.56,
    });
  });

  it('整個區塊沒值：暫無建號、沒有座標', () => {
    expect(buildAnchorPayload(undefined)).toEqual({ key: null, latitude: null, longitude: null });
  });

  it('鍵的欄位缺值時送空字串，讓伺服器回具體的錯誤', () => {
    expect(buildAnchorPayload({ key: { city: 'A' } }).key).toEqual({ city: 'A', town: '', section: '', buildingNo: '', subNo: '' });
  });
});
