// 選單登記的共用型別與常數。各模組的選單檔從這裡取型別，不要反向 import `../nav`，以免循環依賴。

/** 一個選單項目的最小形狀。實際的 `key` 型別由各模組檔的字面值決定，彙總檔再組成聯集。 */
export interface NavEntry {
  readonly key: string;
  readonly label: string;
  readonly href: string;
}

/** 依目前身分才出現的入口：`identity` 是出現條件。 */
export interface IdentityNavEntry extends NavEntry {
  readonly identity: 'practice' | 'operator';
}

/** 個人入口：跟著身分出現，頁面屬於成員本人。 */
export interface PersonalNavEntry extends NavEntry {
  readonly identity: 'practice';
}

/**
 * 一個模組在選單的登記。四個欄位都可省略：
 * - `admin`：後台側邊選單，所有身分共用。
 * - `identity`：依身分才出現的入口（執業主體、審核台）。
 * - `personal`：依身分才出現的個人入口（我的證書）。
 * - `owner`：屋主端上方列。
 */
export interface NavRegistration {
  readonly admin?: readonly NavEntry[];
  readonly identity?: readonly IdentityNavEntry[];
  readonly personal?: readonly PersonalNavEntry[];
  readonly owner?: readonly NavEntry[];
}

// 屋主端在 /owner 底下（MIL-94）。屋主端選單項的 href 由它組出來，殼層分派也用它。
export const OWNER_ROOT_HREF = '/owner';
