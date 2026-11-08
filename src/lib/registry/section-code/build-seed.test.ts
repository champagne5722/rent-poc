import { describe, expect, it } from 'vitest';
import { buildSeed, parseCsv, toFormalTai } from './build-seed';

const SOURCE = { sectionCsvUrl: 's.csv', areaCsvUrl: 'a.csv', downloadedOn: '2026-11-08' };

// 縣市鄉鎮編碼表片段。中正區有兩個事務所，鄉鎮編碼同為 03。部分列結尾多一個逗號。
const AREA_CSV = [
  '﻿縣市名稱,縣市代碼,事務所名稱,事務所代碼,鄉鎮市區名稱,鄉鎮市區代碼',
  '臺北市,A,古亭,AA,中正區,03,',
  '臺北市,A,建成,AB,中正區,03,',
  '臺北市,A,松山,AD,松山區,01,',
  '新北市,F,中和,FH,中和區,18',
  '新北市,F,中和,FH,永和區,33',
  '桃園市,H,大溪,HC,大溪區,02',
  '桃園市,H,蘆竹,HB,觀音區,12',
  '嘉義縣,Q,水上,QD,鹿草鄉,11',
  '嘉義縣,Q,水上,QD,中埔鄉,14',
  '金門縣,W,金門,WA,金湖鎮,01',
  '金門縣,W,金門,WA,金沙鎮,02',
  '金門縣,W,金門,WA,金寧鄉,04',
  '新竹縣,J,竹北,JB,竹北市,05',
  '臺東縣,V,臺東,VA,台東市,01',
].join('\r\n');

const SECTION_HEADER = '﻿段,小段,代碼,備註,所區碼,縣市名稱,鄉鎮名稱,事務所名稱';

function sections(...rows: string[]): string {
  return [SECTION_HEADER, ...rows].join('\r\n');
}

function build(...rows: string[]) {
  return buildSeed({ sectionCsv: sections(...rows), areaCsv: AREA_CSV, source: SOURCE });
}

describe('parseCsv：讀地政司 CSV', () => {
  it.each([
    ['去掉 BOM 與 CRLF', '﻿a,b\r\n1,2\r\n', [['a', 'b'], ['1', '2']]],
    ['保留空欄', 'a,,c\n', [['a', '', 'c']]],
    ['引號內的逗號與跳脫引號', '"x,y","say ""hi"""\n', [['x,y', 'say "hi"']]],
    ['略過空行', 'a\n\n\nb', [['a'], ['b']]],
  ])('%s', (_label, input, expected) => {
    expect(parseCsv(input)).toEqual(expected);
  });
});

describe('toFormalTai：名稱的「台」一律存「臺」', () => {
  it.each([
    ['台中市', '臺中市'],
    ['台西鄉', '臺西鄉'],
    ['臺北市', '臺北市'],
    ['  松山區 ', '松山區'],
  ])('%s → %s', (input, expected) => {
    expect(toFormalTai(input)).toBe(expected);
  });
});

describe('buildSeed：縣市與鄉鎮市區', () => {
  const seed = build();

  it('縣市依字母排序，不重複', () => {
    expect(seed.cities.map((c) => c.code)).toEqual(['A', 'F', 'H', 'J', 'Q', 'V', 'W']);
    expect(seed.cities.find((c) => c.code === 'A')).toEqual({ code: 'A', name: '臺北市' });
  });

  it('同一鄉鎮市區有兩個事務所時只留一列', () => {
    expect(seed.towns.filter((t) => t.cityCode === 'A')).toEqual([
      { cityCode: 'A', code: '01', name: '松山區' },
      { cityCode: 'A', code: '03', name: '中正區' },
    ]);
  });

  it('鄉鎮名稱的「台」存「臺」', () => {
    expect(seed.towns.find((t) => t.cityCode === 'V')?.name).toBe('臺東市');
  });

  it('帶入來源資訊', () => {
    expect(seed.source).toEqual(SOURCE);
  });
});

describe('buildSeed：段碼表', () => {
  it('一般列：段碼保留 4 碼，鄉鎮由所區碼後 2 碼帶出，縣市由事務所代碼帶出', () => {
    expect(build('西松,一,0600,,AD01,臺北市,松山區,松山地政事務所').sections).toEqual([
      { cityCode: 'A', townCode: '01', code: '0600', name: '西松', subName: '一', aliasTownCodes: [], canceled: false },
    ]);
  });

  it('段碼不足 4 碼時補零', () => {
    const seed = build('西松,一,600,,AD01,臺北市,松山區,松山地政事務所', '湖,,9,,WA01,金門縣,金湖鎮,金門地政事務所');
    expect(seed.sections.map((s) => s.code)).toEqual(['0600', '0009']);
  });

  it('註銷列標為已註銷，備註的前後空白不影響判斷', () => {
    const seed = build(
      '敦化,一,0614,註銷,AD01,臺北市,松山區,松山地政事務所',
      '逸仙,二,0618, 註銷 ,AD01,臺北市,松山區,松山地政事務所',
      '濱江,二,0621,更正,AD01,臺北市,松山區,松山地政事務所',
    );
    expect(seed.sections.map((s) => [s.code, s.canceled])).toEqual([
      ['0614', true],
      ['0618', true],
      ['0621', false],
    ]);
  });

  it('跨越段：新北 1818 歸到中和區（18），永和區（33）是別名', () => {
    const seed = build(
      '潭墘,潭墘,1818,跨越,FH33,新北市,永和區,中和地政事務所',
      '潭墘,潭墘,1818,跨越,FH18,新北市,中和區,中和地政事務所',
    );
    expect(seed.sections).toEqual([
      { cityCode: 'F', townCode: '18', code: '1818', name: '潭墘', subName: '潭墘', aliasTownCodes: ['33'], canceled: false },
    ]);
  });

  it('跨越段：只要一列有「跨越」備註就合併，主行政區取鄉鎮編碼最小者', () => {
    const seed = build(
      '北四劃,,0044,,WA04,金門縣,金寧鄉,金門地政事務所',
      '北四劃,,0044,跨越,WA01,金門縣,金湖鎮,金門地政事務所',
    );
    expect(seed.sections).toEqual([
      { cityCode: 'W', townCode: '01', code: '0044', name: '北四劃', subName: '', aliasTownCodes: ['04'], canceled: false },
    ]);
  });

  it('跨越段的別名有多個時依編碼排序', () => {
    const seed = build(
      '北五劃,,0009,跨越,WA04,金門縣,金寧鄉,金門地政事務所',
      '北五劃,,0009,跨越,WA02,金門縣,金沙鎮,金門地政事務所',
      '北五劃,,0009,跨越,WA01,金門縣,金湖鎮,金門地政事務所',
    );
    expect(seed.sections).toMatchObject([{ townCode: '01', aliasTownCodes: ['02', '04'] }]);
  });

  it('跨越段的列全部註銷時才標已註銷', () => {
    const allCanceled = build(
      '北五劃,,0009,跨越,WA01,金門縣,金湖鎮,金門地政事務所',
      '北五劃,,0009,註銷,WA02,金門縣,金沙鎮,金門地政事務所',
    );
    expect(allCanceled.sections).toMatchObject([{ townCode: '01', aliasTownCodes: ['02'], canceled: false }]);
  });

  it('跨越段只出現在一個鄉鎮時，照一般段處理，沒有別名', () => {
    expect(build('舊港,漁寮,0310,跨越,JB05,新竹縣,竹北市,竹北地政事務所').sections).toEqual([
      { cityCode: 'J', townCode: '05', code: '0310', name: '舊港', subName: '漁寮', aliasTownCodes: [], canceled: false },
    ]);
  });

  it('桃園 0400 與嘉義縣 1754 沒有「跨越」備註，各維持兩個不同的段', () => {
    const seed = build(
      '白玉,,0400,,HB12,桃園市,觀音區,蘆竹地政事務所',
      '中庄,中庄,0400,,HC02,桃園市,大溪區,大溪地政事務所',
      '鹿工一,,1754,增編,QD11,嘉義縣,鹿草鄉,水上地政事務所',
      '新吳鳳廟,,1754,增編,QD14,嘉義縣,中埔鄉,水上地政事務所',
    );
    expect(seed.sections.map((s) => [s.cityCode, s.townCode, s.code, s.name, s.aliasTownCodes])).toEqual([
      ['H', '02', '0400', '中庄', []],
      ['H', '12', '0400', '白玉', []],
      ['Q', '11', '1754', '鹿工一', []],
      ['Q', '14', '1754', '新吳鳳廟', []],
    ]);
  });

  it('同縣市同段碼、一列註銷一列現行且沒有跨越備註時，維持兩個段', () => {
    const seed = build(
      '逸仙,二,0618,註銷,AD01,臺北市,松山區,松山地政事務所',
      '逸仙,二,0618,,AA03,臺北市,中正區,古亭地政事務所',
    );
    expect(seed.sections.map((s) => [s.townCode, s.canceled])).toEqual([
      ['01', true],
      ['03', false],
    ]);
  });

  it('段名與小段名的「台」存「臺」', () => {
    expect(build('台安,台一,2034,,AD01,台北市,松山區,松山地政事務所').sections[0]).toMatchObject({
      name: '臺安',
      subName: '臺一',
    });
  });

  it('輸出依縣市、主行政區、段碼排序', () => {
    const seed = build(
      '北四劃,,0044,,WA04,金門縣,金寧鄉,金門地政事務所',
      '西松,二,0601,,AD01,臺北市,松山區,松山地政事務所',
      '西松,一,0600,,AD01,臺北市,松山區,松山地政事務所',
    );
    expect(seed.sections.map((s) => `${s.cityCode}${s.townCode}${s.code}`)).toEqual(['A010600', 'A010601', 'W040044']);
  });

  it.each([
    ['事務所代碼不在編碼表', ['西松,一,0600,,ZZ01,臺北市,松山區,松山地政事務所'], /ZZ/],
    ['鄉鎮不在編碼表', ['西松,一,0600,,AD99,臺北市,松山區,松山地政事務所'], /A99/],
    ['段碼不是數字', ['西松,一,06A0,,AD01,臺北市,松山區,松山地政事務所'], /06A0/],
    ['段碼超過 4 碼', ['西松,一,06000,,AD01,臺北市,松山區,松山地政事務所'], /06000/],
    [
      '同一鄉鎮同一段碼出現兩次',
      ['西松,一,0600,,AD01,臺北市,松山區,松山地政事務所', '西松,二,0600,,AD01,臺北市,松山區,松山地政事務所'],
      /A010600/,
    ],
  ])('資料異常時丟錯，不產出半套 seed：%s', (_label, rows, message) => {
    expect(() => build(...rows)).toThrow(message);
  });

  it('表頭欄位不符時丟錯', () => {
    expect(() => buildSeed({ sectionCsv: 'a,b,c\n1,2,3', areaCsv: AREA_CSV, source: SOURCE })).toThrow(/表頭/);
  });
});
