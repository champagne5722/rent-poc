// 段碼表 seed 的伺服器端載入點（MIL-143）。畫面的選單與請求本文的鍵驗證都從這裡取資料。
// 2 MB 的 JSON 只給 route 與 repository 用，不得從前端元件匯入，也不放進 index.ts 的匯出。

import seed from './seed.json';
import type { SectionCodeSeed } from './types';

export const SECTION_CODE_SEED: SectionCodeSeed = seed as SectionCodeSeed;
