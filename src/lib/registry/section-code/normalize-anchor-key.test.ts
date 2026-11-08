import { describe, expect, it } from 'vitest';
import { buildSeed } from './build-seed';
import { listCities, listSections, listTowns, searchSections } from './lookup';
import { normalizeAnchorKey, type AnchorKeyInput } from './normalize-anchor-key';
import seedJson from './seed.json';
import type { SectionCodeSeed } from './types';

const AREA_CSV = [
  '縣市名稱,縣市代碼,事務所名稱,事務所代碼,鄉鎮市區名稱,鄉鎮市區代碼',
  '臺北市,A,松山,AD,松山區,01',
  '新北市,F,中和,FH,中和區,18',
  '新北市,F,中和,FH,永和區,33',
  '桃園市,H,大溪,HC,大溪區,02',
  '桃園市,H,蘆竹,HB,觀音區,12',
  '臺東縣,V,臺東,VA,臺東市,01',
].join('\n');

const SECTION_CSV = [
  '段,小段,代碼,備註,所區碼,縣市名稱,鄉鎮名稱,事務所名稱',
  '西松,一,0600,,AD01,臺北市,松山區,松山地政事務所',
  '西松,二,0601,,AD01,臺北市,松山區,松山地政事務所',
  '敦化,一,0614,註銷,AD01,臺北市,松山區,松山地政事務所',
  '潭墘,潭墘,1818,跨越,FH18,新北市,中和區,中和地政事務所',
  '潭墘,潭墘,1818,跨越,FH33,新北市,永和區,中和地政事務所',
  '白玉,,0400,,HB12,桃園市,觀音區,蘆竹地政事務所',
  '中庄,中庄,0400,,HC02,桃園市,大溪區,大溪地政事務所',
  '台東,一,0001,,VA01,台東縣,台東市,臺東地政事務所',
].join('\n');

const seed: SectionCodeSeed = buildSeed({
  sectionCsv: SECTION_CSV,
  areaCsv: AREA_CSV,
  source: { sectionCsvUrl: 's', areaCsvUrl: 'a', downloadedOn: '2026-11-08' },
});

const base: AnchorKeyInput = { city: '臺北市', town: '松山區', section: '0600', buildingNo: '1234', subNo: '' };

describe('normalizeAnchorKey：成功的情況', () => {
  it.each<[string, AnchorKeyInput, Record<string, string>]>([
    ['建號補 5 碼，分號空白存 000', base, { cityCode: 'A', townCode: '01', sectionCode: '0600', buildingNo: '01234', subNo: '000' }],
    ['分號補 3 碼', { ...base, subNo: '7' }, { cityCode: 'A', townCode: '01', sectionCode: '0600', buildingNo: '01234', subNo: '007' }],
    ['分號未填（undefined）等同空白', { ...base, subNo: undefined }, { cityCode: 'A', townCode: '01', sectionCode: '0600', buildingNo: '01234', subNo: '000' }],
    ['段碼不足 4 碼時補零', { ...base, section: '600' }, { cityCode: 'A', townCode: '01', sectionCode: '0600', buildingNo: '01234', subNo: '000' }],
    ['以段名加小段名選段', { ...base, section: '西松 二' }, { cityCode: 'A', townCode: '01', sectionCode: '0601', buildingNo: '01234', subNo: '000' }],
    ['段名與小段名之間不空格也行', { ...base, section: '西松二' }, { cityCode: 'A', townCode: '01', sectionCode: '0601', buildingNo: '01234', subNo: '000' }],
    ['縣市與鄉鎮也能填代碼', { ...base, city: 'a', town: '01' }, { cityCode: 'A', townCode: '01', sectionCode: '0600', buildingNo: '01234', subNo: '000' }],
    ['全形數字與前後空白', { ...base, buildingNo: ' １２３４ ', subNo: '００１' }, { cityCode: 'A', townCode: '01', sectionCode: '0600', buildingNo: '01234', subNo: '001' }],
    ['5 碼建號與 3 碼分號原樣保留', { ...base, buildingNo: '00012', subNo: '012' }, { cityCode: 'A', townCode: '01', sectionCode: '0600', buildingNo: '00012', subNo: '012' }],
    ['「台」轉「臺」：縣市、鄉鎮、段名都適用', { city: '台東縣', town: '台東市', section: '台東 一', buildingNo: '5' }, { cityCode: 'V', townCode: '01', sectionCode: '0001', buildingNo: '00005', subNo: '000' }],
    ['從主行政區選跨越段，鍵存主行政區', { city: '新北市', town: '中和區', section: '1818', buildingNo: '9' }, { cityCode: 'F', townCode: '18', sectionCode: '1818', buildingNo: '00009', subNo: '000' }],
    ['從別名行政區選跨越段，鍵改存主行政區', { city: '新北市', town: '永和區', section: '潭墘', buildingNo: '9' }, { cityCode: 'F', townCode: '18', sectionCode: '1818', buildingNo: '00009', subNo: '000' }],
  ])('%s', (_label, input, expected) => {
    const result = normalizeAnchorKey(seed, input);
    expect(result.ok && result.key).toEqual(expected);
  });

  it('桃園 0400 是兩個不同的段，鍵的鄉鎮不同', () => {
    const a = normalizeAnchorKey(seed, { city: '桃園市', town: '觀音區', section: '0400', buildingNo: '1' });
    const b = normalizeAnchorKey(seed, { city: '桃園市', town: '大溪區', section: '0400', buildingNo: '1' });
    expect(a.ok && a.key.townCode).toBe('12');
    expect(b.ok && b.key.townCode).toBe('02');
  });
});

describe('normalizeAnchorKey：錯誤', () => {
  it.each<[string, AnchorKeyInput, string, string]>([
    ['縣市空白', { ...base, city: ' ' }, 'city', 'city-required'],
    ['縣市不存在', { ...base, city: '火星市' }, 'city', 'city-not-found'],
    ['鄉鎮空白', { ...base, town: '' }, 'town', 'town-required'],
    ['鄉鎮不屬於該縣市', { ...base, town: '永和區' }, 'town', 'town-not-found'],
    ['段空白', { ...base, section: '' }, 'section', 'section-required'],
    ['段碼不在該鄉鎮', { ...base, section: '1818' }, 'section', 'section-not-found'],
    ['段名不存在', { ...base, section: '不存在' }, 'section', 'section-not-found'],
    ['段名只寫「西松」對到兩個小段', { ...base, section: '西松' }, 'section', 'section-ambiguous'],
    ['已註銷的段（填段碼）', { ...base, section: '0614' }, 'section', 'section-canceled'],
    ['已註銷的段（填段名）', { ...base, section: '敦化 一' }, 'section', 'section-canceled'],
    ['建號空白', { ...base, buildingNo: '' }, 'buildingNo', 'building-no-required'],
    ['建號超過 5 碼', { ...base, buildingNo: '123456' }, 'buildingNo', 'building-no-invalid'],
    ['建號含非數字', { ...base, buildingNo: '12A' }, 'buildingNo', 'building-no-invalid'],
    ['建號全為零', { ...base, buildingNo: '0' }, 'buildingNo', 'building-no-invalid'],
    ['分號超過 3 碼', { ...base, subNo: '1234' }, 'subNo', 'sub-no-invalid'],
    ['分號含非數字', { ...base, subNo: '1a' }, 'subNo', 'sub-no-invalid'],
  ])('%s', (_label, input, field, code) => {
    const result = normalizeAnchorKey(seed, input);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.map((e) => [e.field, e.code])).toContainEqual([field, code]);
  });

  it('多個欄位有錯時一次回傳全部', () => {
    const result = normalizeAnchorKey(seed, { city: '臺北市', town: '松山區', section: '0614', buildingNo: 'x', subNo: 'y' });
    expect(!result.ok && result.errors.map((e) => e.code)).toEqual([
      'section-canceled',
      'building-no-invalid',
      'sub-no-invalid',
    ]);
  });

  it('縣市錯誤時不再追問鄉鎮與段，但建號分號照樣檢查', () => {
    const result = normalizeAnchorKey(seed, { city: '火星市', town: '松山區', section: '0600', buildingNo: '', subNo: '' });
    expect(!result.ok && result.errors.map((e) => e.code)).toEqual(['city-not-found', 'building-no-required']);
  });
});

describe('listTowns、listSections：選單', () => {
  it('縣市依字母排序', () => {
    expect(listCities(seed).map((c) => c.code)).toEqual(['A', 'F', 'H', 'V']);
  });

  it('依縣市列鄉鎮市區', () => {
    expect(listTowns(seed, 'F').map((t) => t.name)).toEqual(['中和區', '永和區']);
  });

  it('依縣市加鄉鎮列段：別名行政區也要列出，並標註來自別名', () => {
    expect(listSections(seed, 'F', '33').map((o) => [o.section.code, o.viaAlias])).toEqual([['1818', true]]);
    expect(listSections(seed, 'F', '18').map((o) => [o.section.code, o.viaAlias])).toEqual([['1818', false]]);
  });

  it('預設不列已註銷的段，要求時才列', () => {
    expect(listSections(seed, 'A', '01').map((o) => o.section.code)).toEqual(['0600', '0601']);
    expect(listSections(seed, 'A', '01', { includeCanceled: true }).map((o) => o.section.code)).toEqual([
      '0600',
      '0601',
      '0614',
    ]);
  });

  it('鄉鎮沒有段時回空陣列', () => {
    expect(listSections(seed, 'H', '99')).toEqual([]);
  });
});

describe('searchSections：依段名搜尋', () => {
  it.each<[string, string, string[]]>([
    ['段名開頭', '西', ['0600', '0601']],
    ['含小段名的全名', '西松 二', ['0601']],
    ['忽略空白', '西 松二', ['0601']],
    ['「台」視同「臺」', '台東', ['0001']],
    ['數字視為段碼', '600', ['0600']],
    ['不在已註銷的段', '敦化', []],
    ['空字串回空陣列', '  ', []],
  ])('%s', (_label, query, codes) => {
    expect(searchSections(seed, query).map((o) => o.section.code)).toEqual(codes);
  });

  it('完全相同的排在開頭相同的前面', () => {
    const s = searchSections(seed, '西松');
    expect(s.map((o) => o.section.subName)).toEqual(['一', '二']);
    expect(searchSections(seed, '西松 一').map((o) => o.section.code)).toEqual(['0600']);
  });

  it('可限縮縣市與鄉鎮，別名行政區也搜得到', () => {
    expect(searchSections(seed, '潭墘', { cityCode: 'F', townCode: '33' }).map((o) => o.viaAlias)).toEqual([true]);
    expect(searchSections(seed, '潭墘', { cityCode: 'A' })).toEqual([]);
    expect(searchSections(seed, '白玉', { cityCode: 'H', townCode: '02' })).toEqual([]);
  });

  it('要求時才含已註銷的段', () => {
    expect(searchSections(seed, '敦化', { includeCanceled: true }).map((o) => o.section.code)).toEqual(['0614']);
  });
});

describe('提交的 seed.json（2026-11-08 的真實資料）', () => {
  const real = seedJson as SectionCodeSeed;

  it('格式符合 ADR-0025 決議 3', () => {
    expect(real.cities.every((c) => /^[A-Z]$/.test(c.code))).toBe(true);
    expect(real.towns.every((t) => /^\d{2}$/.test(t.code))).toBe(true);
    expect(real.sections.every((s) => /^\d{4}$/.test(s.code) && /^\d{2}$/.test(s.townCode))).toBe(true);
  });

  it('沒有「台」字，鍵不重複', () => {
    expect(real.sections.some((s) => /台/.test(s.name + s.subName))).toBe(false);
    const keys = real.sections.map((s) => s.cityCode + s.townCode + s.code);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('跨越段歸主行政區，別名可選到', () => {
    const aliased = real.sections
      .filter((s) => s.aliasTownCodes.length > 0)
      .map((s) => `${s.cityCode}${s.townCode}${s.code}+${s.aliasTownCodes.join('/')}`);
    expect(aliased).toEqual(['F181818+33', 'W010009+02', 'W010044+04']);
    const key = normalizeAnchorKey(real, { city: '新北市', town: '永和區', section: '1818', buildingNo: '1' });
    expect(key.ok && key.key.townCode).toBe('18');
  });

  it('桃園 0400 與嘉義縣 1754 維持兩個不同的段', () => {
    const tao = real.sections.filter((s) => s.cityCode === 'H' && s.code === '0400');
    const chia = real.sections.filter((s) => s.cityCode === 'Q' && s.code === '1754');
    expect(tao.length).toBe(2);
    expect(chia.length).toBe(2);
    expect([...tao, ...chia].every((s) => s.aliasTownCodes.length === 0)).toBe(true);
  });

  it('註銷列標為已註銷', () => {
    expect(real.sections.filter((s) => s.canceled).length).toBe(1606);
  });
});
