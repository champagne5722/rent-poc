// 把地政司的全國段碼表 CSV 與縣市鄉鎮市區編碼表 CSV 轉成 seed。決議見 ADR-0025 決議 1、3、4、5。
//
// 這個檔案也由 `scripts/registry/import-section-codes.mjs` 以 Node 直接執行（型別剝除），
// 所以只用可剝除的 TypeScript 語法，且不得有執行期的相對匯入。

import type { City, SectionCodeSeed, SeedSource, Section, Town } from './types';

const SECTION_HEADER = ['段', '小段', '代碼', '備註', '所區碼', '縣市名稱', '鄉鎮名稱', '事務所名稱'];
const AREA_HEADER = ['縣市名稱', '縣市代碼', '事務所名稱', '事務所代碼', '鄉鎮市區名稱', '鄉鎮市區代碼'];

const REMARK_CANCELED = '註銷';
const REMARK_CROSSING = '跨越';

/** 名稱去掉前後空白，「台」一律換成「臺」。 */
export function toFormalTai(name: string): string {
  return name.trim().replace(/台/g, '臺');
}

/** 讀 CSV 成二維陣列。處理 BOM、CRLF、引號欄位，略過空行。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      endRow();
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

function readTable(text: string, header: string[], label: string): string[][] {
  const [head, ...body] = parseCsv(text);
  const actual = (head ?? []).slice(0, header.length).map((h) => h.trim());
  if (actual.join(',') !== header.join(',')) {
    throw new Error(`${label}的表頭不符，預期 ${header.join(',')}，實際 ${actual.join(',')}`);
  }
  return body;
}

function byCode<T extends { code: string }>(a: T, b: T): number {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

function sectionOrder(a: Section, b: Section): number {
  const ka = `${a.cityCode}${a.townCode}${a.code}`;
  const kb = `${b.cityCode}${b.townCode}${b.code}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

interface SectionRow {
  cityCode: string;
  townCode: string;
  code: string;
  name: string;
  subName: string;
  canceled: boolean;
  crossing: boolean;
}

export interface BuildSeedInput {
  sectionCsv: string;
  areaCsv: string;
  source: SeedSource;
}

/**
 * 產出 seed。資料有異常（未知事務所或鄉鎮、段碼格式錯、鍵重複）時丟錯，不產出半套 seed。
 *
 * - 段碼補成 4 碼。名稱的「台」存「臺」。
 * - 備註「註銷」的列標為已註銷。
 * - 同縣市同段碼出現在多個鄉鎮，且任一列備註「跨越」時，合併成一個段。
 *   主行政區取鄉鎮編碼最小者，其餘是別名。所有列都註銷時才標已註銷。
 * - 沒有「跨越」備註的同碼列（例如桃園 0400、嘉義縣 1754）維持各自的段。
 */
export function buildSeed(input: BuildSeedInput): SectionCodeSeed {
  const areaRows = readTable(input.areaCsv, AREA_HEADER, '縣市鄉鎮市區編碼表');

  const cities = new Map<string, City>();
  const towns = new Map<string, Town>();
  const officeToCity = new Map<string, string>();
  for (const r of areaRows) {
    const [cityName, cityCode, , officeCode, townName, townCode] = r.map((v) => v.trim());
    if (!/^[A-Z]$/.test(cityCode) || !/^\d{2}$/.test(townCode) || !/^[A-Z]{2}$/.test(officeCode)) {
      throw new Error(`縣市鄉鎮市區編碼表有格式錯誤的列：${r.join(',')}`);
    }
    if (!cities.has(cityCode)) cities.set(cityCode, { code: cityCode, name: toFormalTai(cityName) });
    const townKey = `${cityCode}${townCode}`;
    if (!towns.has(townKey)) towns.set(townKey, { cityCode, code: townCode, name: toFormalTai(townName) });
    officeToCity.set(officeCode, cityCode);
  }

  const sectionRows = readTable(input.sectionCsv, SECTION_HEADER, '段碼表');
  const parsed: SectionRow[] = sectionRows.map((r) => {
    const [name, subName, rawCode, rawRemark, officeTown] = r.map((v) => v.trim());
    const officeCode = officeTown.slice(0, 2);
    const townCode = officeTown.slice(2);
    const cityCode = officeToCity.get(officeCode);
    if (!cityCode) throw new Error(`段碼表的事務所代碼 ${officeCode} 不在編碼表：${r.join(',')}`);
    if (!towns.has(`${cityCode}${townCode}`)) {
      throw new Error(`段碼表的鄉鎮 ${cityCode}${townCode} 不在編碼表：${r.join(',')}`);
    }
    if (!/^\d{1,4}$/.test(rawCode)) throw new Error(`段碼 ${rawCode} 不是 1 到 4 位數字：${r.join(',')}`);
    return {
      cityCode,
      townCode,
      code: rawCode.padStart(4, '0'),
      name: toFormalTai(name),
      subName: toFormalTai(subName),
      canceled: rawRemark === REMARK_CANCELED,
      crossing: rawRemark === REMARK_CROSSING,
    };
  });

  const seen = new Set<string>();
  for (const s of parsed) {
    const key = `${s.cityCode}${s.townCode}${s.code}`;
    if (seen.has(key)) throw new Error(`段碼表有重複的鍵 ${key}`);
    seen.add(key);
  }

  const groups = new Map<string, SectionRow[]>();
  for (const s of parsed) {
    const key = `${s.cityCode}${s.code}`;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }

  const sections: Section[] = [];
  for (const rows of groups.values()) {
    if (rows.some((s) => s.crossing)) {
      const sorted = [...rows].sort((a, b) => (a.townCode < b.townCode ? -1 : 1));
      const [primary, ...aliases] = sorted;
      sections.push({
        cityCode: primary.cityCode,
        townCode: primary.townCode,
        code: primary.code,
        name: primary.name,
        subName: primary.subName,
        aliasTownCodes: aliases.map((a) => a.townCode),
        canceled: sorted.every((s) => s.canceled),
      });
    } else {
      for (const s of rows) {
        sections.push({
          cityCode: s.cityCode,
          townCode: s.townCode,
          code: s.code,
          name: s.name,
          subName: s.subName,
          aliasTownCodes: [],
          canceled: s.canceled,
        });
      }
    }
  }

  return {
    source: input.source,
    cities: [...cities.values()].sort(byCode),
    towns: [...towns.values()].sort((a, b) => byCode({ code: a.cityCode + a.code }, { code: b.cityCode + b.code })),
    sections: sections.sort(sectionOrder),
  };
}

/**
 * 把 seed 序列化成 JSON。每筆資料一行，方便每季更新時看 diff。
 */
export function serializeSeed(seed: SectionCodeSeed): string {
  const lines = (items: unknown[]) => items.map((item) => `    ${JSON.stringify(item)}`).join(',\n');
  return [
    '{',
    `  "source": ${JSON.stringify(seed.source)},`,
    '  "cities": [',
    lines(seed.cities),
    '  ],',
    '  "towns": [',
    lines(seed.towns),
    '  ],',
    '  "sections": [',
    lines(seed.sections),
    '  ]',
    '}',
    '',
  ].join('\n');
}
