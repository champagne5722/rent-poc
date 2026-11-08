// 段碼表 seed 的資料型別。格式依 ADR-0025 決議 3：縣市 1 碼字母、鄉鎮市區 2 碼、段碼 4 碼。

/** 縣市。`code` 是地政編碼的 1 碼英文字母。 */
export interface City {
  code: string;
  name: string;
}

/** 鄉鎮市區。`code` 是 2 碼數字，與縣市合用才唯一。 */
export interface Town {
  cityCode: string;
  code: string;
  name: string;
}

/**
 * 段小段。鍵是 `cityCode`、`townCode`、`code` 三欄。
 * 跨越段的 `townCode` 是主行政區（鄉鎮編碼最小者），其餘鄉鎮放在 `aliasTownCodes`。
 */
export interface Section {
  cityCode: string;
  townCode: string;
  code: string;
  name: string;
  /** 小段名，沒有小段時是空字串。 */
  subName: string;
  aliasTownCodes: string[];
  canceled: boolean;
}

export interface SeedSource {
  sectionCsvUrl: string;
  areaCsvUrl: string;
  /** 下載日期，格式 `YYYY-MM-DD`，由匯入腳本的參數帶入。 */
  downloadedOn: string;
}

export interface SectionCodeSeed {
  source: SeedSource;
  cities: City[];
  towns: Town[];
  sections: Section[];
}
