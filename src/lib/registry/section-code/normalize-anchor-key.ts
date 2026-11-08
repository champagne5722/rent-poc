// 產權錨點的鍵正規化。決議見 ADR-0025 決議 3、4、5。
// 輸入使用者填的縣市、鄉鎮市區、段、建號、分號，輸出五欄鍵或錯誤清單。純函式，不碰資料庫。

import { toFormalTai } from './build-seed';
import { listSections, searchSections } from './lookup';
import type { Section, SectionCodeSeed } from './types';

export interface AnchorKeyInput {
  /** 縣市名稱或 1 碼字母代碼。 */
  city: string;
  /** 鄉鎮市區名稱或 2 碼數字代碼。 */
  town: string;
  /** 段碼（1 到 4 位數字）或段名。段名可帶小段名，例如「西松 一」。 */
  section: string;
  /** 建號，1 到 5 位數字。 */
  buildingNo: string;
  /** 分號，1 到 3 位數字。空白視為沒有分號。 */
  subNo?: string;
}

/** ADR-0013 決議 2 的五欄鍵，格式依 ADR-0025 決議 3。 */
export interface AnchorKey {
  cityCode: string;
  townCode: string;
  sectionCode: string;
  buildingNo: string;
  subNo: string;
}

export type AnchorKeyErrorCode =
  | 'city-required'
  | 'city-not-found'
  | 'town-required'
  | 'town-not-found'
  | 'section-required'
  | 'section-not-found'
  | 'section-ambiguous'
  | 'section-canceled'
  | 'building-no-required'
  | 'building-no-invalid'
  | 'sub-no-invalid';

export interface AnchorKeyError {
  field: keyof AnchorKeyInput;
  code: AnchorKeyErrorCode;
  message: string;
}

export type NormalizeAnchorKeyResult =
  | { ok: true; key: AnchorKey; section: Section }
  | { ok: false; errors: AnchorKeyError[] };

export const BUILDING_NO_LENGTH = 5;
export const SUB_NO_LENGTH = 3;
export const NO_SUB_NO = '000';

/** 全形轉半形、去掉前後空白。 */
function clean(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').trim();
}

/** 把數字文字補零。不是 1 到 `length` 位數字時回傳 null。 */
export function padDigits(value: string, length: number): string | null {
  const text = clean(value);
  if (!new RegExp(`^\\d{1,${length}}$`).test(text)) return null;
  return text.padStart(length, '0');
}

/**
 * 正規化使用者填的產權錨點鍵。所有欄位的錯誤一次回傳。
 *
 * - 段碼補 4 碼、建號補 5 碼、分號補 3 碼，分號空白存 `000`。
 * - 從別名行政區選到跨越段時，鍵存主行政區。
 * - 段碼已註銷回傳 `section-canceled`，不自動改鍵。
 * - 名稱的「台」視同「臺」。
 */
export function normalizeAnchorKey(seed: SectionCodeSeed, input: AnchorKeyInput): NormalizeAnchorKeyResult {
  const errors: AnchorKeyError[] = [];
  const fail = (field: AnchorKeyError['field'], code: AnchorKeyErrorCode, message: string) => {
    errors.push({ field, code, message });
  };

  // 縣市
  const cityText = toFormalTai(clean(input.city));
  const city =
    cityText === '' ? undefined : seed.cities.find((c) => c.code === cityText.toUpperCase() || c.name === cityText);
  if (cityText === '') fail('city', 'city-required', '必須選縣市');
  else if (!city) fail('city', 'city-not-found', `找不到縣市「${cityText}」`);

  // 鄉鎮市區
  const townText = toFormalTai(clean(input.town));
  const town =
    city && townText !== ''
      ? seed.towns.find((t) => t.cityCode === city.code && (t.code === townText || t.name === townText))
      : undefined;
  if (townText === '') fail('town', 'town-required', '必須選鄉鎮市區');
  else if (city && !town) fail('town', 'town-not-found', `${city.name}沒有「${townText}」`);

  // 段：從這個鄉鎮的可選段（含別名）找，找到後鍵存主行政區
  let section: Section | undefined;
  const sectionText = clean(input.section);
  if (sectionText === '') {
    fail('section', 'section-required', '必須選段小段');
  } else if (city && town) {
    const compact = toFormalTai(sectionText).replace(/\s+/g, '');
    const candidates = /^\d{1,4}$/.test(sectionText)
      ? listSections(seed, city.code, town.code, { includeCanceled: true }).filter(
          (o) => o.section.code === sectionText.padStart(4, '0'),
        )
      : searchSections(seed, sectionText, { cityCode: city.code, townCode: town.code, includeCanceled: true }).filter(
          (o) => o.section.name === compact || o.section.name + o.section.subName === compact,
        );
    if (candidates.length === 0) {
      fail('section', 'section-not-found', `${town.name}找不到段「${sectionText}」`);
    } else if (candidates.length > 1) {
      fail('section', 'section-ambiguous', `「${sectionText}」對到多個段，必須加上小段名或改填段碼`);
    } else if (candidates[0].section.canceled) {
      fail('section', 'section-canceled', `段「${sectionText}」的段碼已註銷，必須改選現行的段`);
    } else {
      section = candidates[0].section;
    }
  }

  // 建號、分號
  const buildingText = clean(input.buildingNo);
  const buildingNo = padDigits(buildingText, BUILDING_NO_LENGTH);
  if (buildingText === '') fail('buildingNo', 'building-no-required', '必須填建號');
  else if (buildingNo === null || /^0+$/.test(buildingNo)) {
    fail('buildingNo', 'building-no-invalid', '建號必須是 1 到 5 位數字，且不得全為零');
  }

  const subText = clean(input.subNo);
  const subNo = subText === '' ? NO_SUB_NO : padDigits(subText, SUB_NO_LENGTH);
  if (subNo === null) fail('subNo', 'sub-no-invalid', '分號必須是 1 到 3 位數字');

  if (errors.length > 0 || !section || buildingNo === null || subNo === null) return { ok: false, errors };
  return {
    ok: true,
    section,
    key: {
      cityCode: section.cityCode,
      townCode: section.townCode,
      sectionCode: section.code,
      buildingNo,
      subNo,
    },
  };
}
