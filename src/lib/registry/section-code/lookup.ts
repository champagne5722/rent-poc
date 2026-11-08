// 段碼表的查詢輔助。輸入 seed，不碰資料庫。決議見 ADR-0025 決議 4、5。

import { toFormalTai } from './build-seed';
import type { City, Section, SectionCodeSeed, Town } from './types';

/** 可選的段。`viaAlias` 為 true 表示使用者是從別名行政區找到它，鍵仍存主行政區。 */
export interface SectionOption {
  section: Section;
  viaAlias: boolean;
}

export interface ListSectionsOptions {
  /** 預設 false：已註銷的段不出現在選單。 */
  includeCanceled?: boolean;
}

/** 縣市，依字母排序。 */
export function listCities(seed: SectionCodeSeed): City[] {
  return seed.cities;
}

/** 某縣市底下的鄉鎮市區，依編碼排序。 */
export function listTowns(seed: SectionCodeSeed, cityCode: string): Town[] {
  return seed.towns.filter((t) => t.cityCode === cityCode);
}

/**
 * 某縣市加鄉鎮市區可選的段。主行政區是這個鄉鎮的段與別名行政區含這個鄉鎮的段都要列出。
 * 預設不含已註銷的段。
 */
export function listSections(
  seed: SectionCodeSeed,
  cityCode: string,
  townCode: string,
  options: ListSectionsOptions = {},
): SectionOption[] {
  const result: SectionOption[] = [];
  for (const section of seed.sections) {
    if (section.cityCode !== cityCode) continue;
    if (section.canceled && !options.includeCanceled) continue;
    if (section.townCode === townCode) result.push({ section, viaAlias: false });
    else if (section.aliasTownCodes.includes(townCode)) result.push({ section, viaAlias: true });
  }
  return result;
}

export interface SearchSectionsOptions extends ListSectionsOptions {
  /** 限縮到某縣市。 */
  cityCode?: string;
  /** 限縮到某鄉鎮市區，別名行政區也算。需同時給 `cityCode`。 */
  townCode?: string;
}

/** 段的顯示名稱：有小段時是「段名 小段名」。 */
export function sectionLabel(section: Pick<Section, 'name' | 'subName'>): string {
  return section.subName ? `${section.name} ${section.subName}` : section.name;
}

function squash(text: string): string {
  return toFormalTai(text).replace(/\s+/g, '');
}

/**
 * 依段名搜尋。空白不影響比對，「台」視同「臺」。
 * 段名或「段名加小段名」以查詢字串開頭即命中，完全相同的排在前面。
 * 查詢字串是 1 到 4 位數字時，視為段碼完整比對。
 */
export function searchSections(
  seed: SectionCodeSeed,
  query: string,
  options: SearchSectionsOptions = {},
): SectionOption[] {
  const q = squash(query);
  if (q === '') return [];
  const asCode = /^\d{1,4}$/.test(q) ? q.padStart(4, '0') : null;

  const exact: SectionOption[] = [];
  const prefix: SectionOption[] = [];
  for (const section of seed.sections) {
    if (options.cityCode !== undefined && section.cityCode !== options.cityCode) continue;
    if (section.canceled && !options.includeCanceled) continue;
    let viaAlias = false;
    if (options.townCode !== undefined) {
      if (section.townCode === options.townCode) viaAlias = false;
      else if (section.aliasTownCodes.includes(options.townCode)) viaAlias = true;
      else continue;
    }
    if (asCode !== null) {
      if (section.code === asCode) exact.push({ section, viaAlias });
      continue;
    }
    const name = squash(section.name);
    const full = name + squash(section.subName);
    if (name === q || full === q) exact.push({ section, viaAlias });
    else if (name.startsWith(q) || full.startsWith(q)) prefix.push({ section, viaAlias });
  }
  return [...exact, ...prefix];
}
