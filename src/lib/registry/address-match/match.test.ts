import { describe, expect, it } from 'vitest';
import {
  detectSuspectedDuplicate,
  findSuspectedDuplicates,
  haversineMeters,
  type RegistryAddress,
} from './index';

const BASE: RegistryAddress = {
  countyLetter: 'A',
  districtCode: '03',
  doorplate: '羅斯福路3段283巷14弄5號',
  floor: '3',
  room: '301',
};
const METERS_PER_DEG_LAT = 111195;
const north = (lat: number, meters: number) => lat + meters / METERS_PER_DEG_LAT;
const P = { lat: 25.0173, lng: 121.5398 };

const CASES: Array<[label: string, patch: Partial<RegistryAddress>, suspected: boolean, reasons: string[]]> = [
  ['門牌、樓層、房號全同', {}, true, ['DOORPLATE_SAME']],
  ['樓層寫法不同但等價', { floor: '3樓', room: '301室' }, true, ['DOORPLATE_SAME']],
  ['樓層國字', { floor: '三樓' }, true, ['DOORPLATE_SAME']],
  ['一方樓層空白', { floor: null }, true, ['DOORPLATE_SAME']],
  ['一方房號空白', { room: '' }, true, ['DOORPLATE_SAME']],
  ['兩方樓層房號皆空白', { floor: null, room: null }, true, ['DOORPLATE_SAME']],
  ['樓層不同', { floor: '4' }, false, []],
  ['房號不同', { room: '302' }, false, []],
  ['門牌不同', { doorplate: '羅斯福路3段283巷14弄7號' }, false, []],
  ['不同縣市', { countyLetter: 'B' }, false, []],
  ['縣市字母大小寫不分', { countyLetter: 'a' }, true, ['DOORPLATE_SAME']],
  ['不同鄉鎮市區', { districtCode: '04' }, false, []],
  ['不同縣市，門牌與座標都相同仍不是', { countyLetter: 'B', coordinate: P }, false, []],
];

describe('detectSuspectedDuplicate 門牌規則', () => {
  it.each(CASES)('%s', (_l, patch, suspected, reasons) => {
    const result = detectSuspectedDuplicate({ ...BASE, coordinate: P }, { ...BASE, ...patch });
    expect(result.suspected).toBe(suspected);
    expect(result.reasons).toEqual(reasons);
  });

  it('門牌為空字串不算相同', () => {
    const a = { ...BASE, doorplate: '' };
    expect(detectSuspectedDuplicate(a, { ...a }).suspected).toBe(false);
  });

  it('兩個方向結果相同', () => {
    const other = { ...BASE, floor: null };
    expect(detectSuspectedDuplicate(other, BASE)).toEqual(detectSuspectedDuplicate(BASE, other));
  });
});

describe('detectSuspectedDuplicate 座標規則', () => {
  const far: RegistryAddress = { ...BASE, doorplate: '別條路9號', floor: '9', room: '9' };
  const far2: RegistryAddress = { ...far, doorplate: '另一條路1號' };

  it('距離 14 公尺命中', () => {
    const a = { ...far, coordinate: P };
    const b = { ...far2, coordinate: { lat: north(P.lat, 14), lng: P.lng } };
    const d = haversineMeters(P, b.coordinate);
    expect(d).toBeGreaterThan(13.9);
    expect(d).toBeLessThan(14.1);
    expect(detectSuspectedDuplicate(a, b)).toEqual({ suspected: true, reasons: ['COORDINATE_NEAR'] });
  });

  it('距離 16 公尺不命中', () => {
    const a = { ...far, coordinate: P };
    const b = { ...far2, coordinate: { lat: north(P.lat, 16), lng: P.lng } };
    expect(detectSuspectedDuplicate(a, b).suspected).toBe(false);
  });

  it('門檻是參數：30 公尺門檻下 16 公尺命中，10 公尺門檻下 14 公尺不命中', () => {
    const a = { ...far, coordinate: P };
    const b16 = { ...far2, coordinate: { lat: north(P.lat, 16), lng: P.lng } };
    const b14 = { ...far2, coordinate: { lat: north(P.lat, 14), lng: P.lng } };
    expect(detectSuspectedDuplicate(a, b16, { distanceThresholdMeters: 30 }).suspected).toBe(true);
    expect(detectSuspectedDuplicate(a, b14, { distanceThresholdMeters: 10 }).suspected).toBe(false);
  });

  it('東西向位移同樣以公尺計', () => {
    const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((P.lat * Math.PI) / 180);
    const a = { ...far, coordinate: P };
    const b14 = { ...far2, coordinate: { lat: P.lat, lng: P.lng + 14 / metersPerDegLng } };
    const b16 = { ...far2, coordinate: { lat: P.lat, lng: P.lng + 16 / metersPerDegLng } };
    expect(detectSuspectedDuplicate(a, b14).suspected).toBe(true);
    expect(detectSuspectedDuplicate(a, b16).suspected).toBe(false);
  });

  it('一方沒有座標不比座標', () => {
    const other = { ...far, doorplate: '另一條路1號' };
    expect(detectSuspectedDuplicate({ ...far, coordinate: P }, { ...other, coordinate: null }).suspected).toBe(false);
    expect(detectSuspectedDuplicate({ ...far, coordinate: P }, other).suspected).toBe(false);
  });

  it('座標不合法視同沒有', () => {
    const bad = { ...far, doorplate: '另一條路1號', coordinate: { lat: Number.NaN, lng: 121 } };
    expect(detectSuspectedDuplicate({ ...far, coordinate: P }, bad).suspected).toBe(false);
  });

  it('門牌與座標都命中時兩個原因都列出', () => {
    const a = { ...BASE, coordinate: P };
    const b = { ...BASE, coordinate: { lat: north(P.lat, 5), lng: P.lng } };
    expect(detectSuspectedDuplicate(a, b).reasons).toEqual(['DOORPLATE_SAME', 'COORDINATE_NEAR']);
  });

  it('haversine 對照已知距離：緯度差 1 度約 111.2 公里', () => {
    const d = haversineMeters({ lat: 25, lng: 121 }, { lat: 26, lng: 121 });
    expect(d).toBeGreaterThan(111000);
    expect(d).toBeLessThan(111400);
    expect(haversineMeters(P, P)).toBe(0);
  });
});

describe('findSuspectedDuplicates', () => {
  const target: RegistryAddress = { ...BASE, id: 'new', coordinate: P };
  const candidates: RegistryAddress[] = [
    { ...BASE, id: 'c1' },
    { ...BASE, id: 'c2', floor: '9' },
    { ...BASE, id: 'c3', doorplate: '別路1號', coordinate: { lat: north(P.lat, 10), lng: P.lng } },
    { ...BASE, id: 'c4', districtCode: '99' },
    { ...BASE, id: 'new' },
  ];

  it('回傳命中的候選與原因，保留輸入順序，略過自己', () => {
    const result = findSuspectedDuplicates(target, candidates);
    expect(result.map((r) => [r.candidate.id, r.reasons])).toEqual([
      ['c1', ['DOORPLATE_SAME']],
      ['c3', ['COORDINATE_NEAR']],
    ]);
  });

  it('空清單回傳空陣列', () => {
    expect(findSuspectedDuplicates(target, [])).toEqual([]);
  });

  it('門檻參數會傳下去', () => {
    const result = findSuspectedDuplicates(target, candidates, { distanceThresholdMeters: 5 });
    expect(result.map((r) => r.candidate.id)).toEqual(['c1']);
  });
});
