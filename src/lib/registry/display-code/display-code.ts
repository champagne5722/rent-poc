/**
 * 租賃單位顯示編碼（ADR-0013 決議 7、ADR-0025 決議 12）。
 *
 * 格式：縣市字母 1 碼加鄉鎮市區編碼 2 碼、連字號、租賃單位 ULID 末 6 碼，例如 `F18-7K3QZP`。
 * 顯示編碼不含段碼與建號（R13）。
 *
 * 使用限制：
 * - 顯示編碼不保證唯一。兩個單位的 ULID 末 6 碼可能相同。
 * - 顯示編碼只供口頭溝通與畫面顯示。系統內查詢、外鍵、URL 一律用 ULID。
 * - 解析結果只能當搜尋線索。識別單位必須用完整 ULID。
 * - 被合併的單位顯示存續單位的編碼。本模組不解析合併關係，呼叫端必須傳入存續單位的 ULID。
 *
 * ULID 字元集是 Crockford base32 大寫：數字 0-9 與英文字母，排除 I、L、O、U。
 */

const SUFFIX_LENGTH = 6;

const COUNTY = '[A-Z]';
const TOWN = '[0-9]{2}';
/** Crockford base32 大寫字元集。 */
const CROCKFORD = '[0-9A-HJKMNP-TV-Z]';

const COUNTY_LETTER = new RegExp(`^${COUNTY}$`);
const TOWN_CODE = new RegExp(`^${TOWN}$`);
const ULID = new RegExp(`^[0-7]${CROCKFORD}{25}$`);
const DISPLAY_CODE = new RegExp(`^(${COUNTY})(${TOWN})-(${CROCKFORD}{${SUFFIX_LENGTH}})$`);

/** 全形連字號與其他 Unicode 連字號、減號。解析前一律換成 `-`。 */
const DASH_VARIANTS = /[\uFF0D\u2010\u2011\u2012\u2013\u2014\u2212]/g;

export type DisplayCodeInput = {
  /** 縣市字母，1 碼英文字母，例如臺南市 `D`。大小寫皆可。 */
  countyLetter: string;
  /** 鄉鎮市區編碼，2 碼數字，例如 `18`。 */
  townCode: string;
  /** 租賃單位 ULID，26 碼。被合併的單位必須傳入存續單位的 ULID。大小寫皆可。 */
  rentalUnitId: string;
};

export type DisplayCodeField = keyof DisplayCodeInput;

/** `formatDisplayCode` 的輸入格式不符時丟出。`field` 指出哪個欄位不符。 */
export class DisplayCodeFormatError extends Error {
  readonly field: DisplayCodeField;

  constructor(field: DisplayCodeField, value: string) {
    super(`顯示編碼的 ${field} 格式不符：${JSON.stringify(value)}`);
    this.name = 'DisplayCodeFormatError';
    this.field = field;
  }
}

export type ParsedDisplayCode = {
  ok: true;
  countyLetter: string;
  townCode: string;
  /** ULID 末 6 碼，大寫。不足以唯一指出一個單位。 */
  rentalUnitIdSuffix: string;
};

export type ParseDisplayCodeResult = ParsedDisplayCode | { ok: false; reason: 'invalid-format' };

/**
 * 產生顯示編碼。輸入格式不符時丟出 `DisplayCodeFormatError`。
 * 輸入來自系統資料，格式不符代表資料有誤，所以用丟出而非回傳錯誤。
 */
export function formatDisplayCode(input: DisplayCodeInput): string {
  const countyLetter = input.countyLetter.toUpperCase();
  const rentalUnitId = input.rentalUnitId.toUpperCase();

  if (!COUNTY_LETTER.test(countyLetter)) {
    throw new DisplayCodeFormatError('countyLetter', input.countyLetter);
  }
  if (!TOWN_CODE.test(input.townCode)) {
    throw new DisplayCodeFormatError('townCode', input.townCode);
  }
  if (!ULID.test(rentalUnitId)) {
    throw new DisplayCodeFormatError('rentalUnitId', input.rentalUnitId);
  }

  return `${countyLetter}${input.townCode}-${rentalUnitId.slice(-SUFFIX_LENGTH)}`;
}

/**
 * 解析使用者輸入的顯示編碼。容忍前後空白、小寫與全形連字號。
 * 輸入來自使用者，格式不符屬正常情況，所以回傳結果而非丟出。
 */
export function parseDisplayCode(text: string): ParseDisplayCodeResult {
  const normalized = text.trim().replace(DASH_VARIANTS, '-').toUpperCase();
  const match = DISPLAY_CODE.exec(normalized);
  if (!match) return { ok: false, reason: 'invalid-format' };

  const [, countyLetter, townCode, rentalUnitIdSuffix] = match;
  return { ok: true, countyLetter, townCode, rentalUnitIdSuffix };
}
