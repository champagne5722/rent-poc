// 申請：委託管理申請與住宅包租申請（MIL-206，spec MIL-193，ADR-0029、ADR-0030）。
// 兩張表都放 registry，app_rw 沒有任何權限，讀寫都經定義者函式。每個函式的政策（誰能呼叫、回什麼、為什麼）
// 寫在 migration 0086 的函式註解，與 Linear MIL-206 的留言。
// 這些函式的參數是申請 ID 或碼的雜湊，不是物件、錨點或租賃單位 ID，所以沒有「A 組織的物件」可探測，probe 填 null。
// 跨組織與無效碼的逐位元比對寫在 src/lib/pg/mandate-requests-schema.test.ts 與 src/app/api/mandate-requests 的 route 測試。
import type { DefinerOnlyTable, RegistryFunctionCase, RegistryTableCase, RlsRegistration } from './types';

const registryTables: Record<string, RegistryTableCase> = {
  'registry.mandate_requests': {
    purpose:
      '申請本體：業者產生的委託管理申請與住宅包租申請。含碼的雜湊、業者代填的資料與謄本、屋主組織的綁定、送出與收回時間。跨業者與屋主兩個組織，所以不放 org 表（MIL-206）',
  },
  'registry.mandate_request_units': {
    purpose: '申請含的租賃單位。屋主送出時寫入。屋主送出時查「租賃單位已被佔用」只讀屋主自己組織的申請（MIL-206）',
  },
};

const definerOnlyTables: Record<string, DefinerOnlyTable> = {
  'registry.mandate_requests': {
    reason:
      '申請本體（MIL-206）。只經 registry.create_mandate_request 等定義者函式讀寫，app_rw 沒有任何權限。業者端的函式不回傳屋主組織、綁定與確認時間，所以屋主有沒有打開連結，業者看不出來',
  },
  'registry.mandate_request_units': {
    reason: '申請含的租賃單位（MIL-206）。只經 registry.submit_mandate_request 寫入，app_rw 沒有任何權限',
  },
};

const NO_OBJECT_ID = '參數是申請 ID 或碼的雜湊，不是物件或租賃單位的 ID，沒有「A 組織的物件」可探測。跨組織與無效碼的逐位元比對在 mandate-requests-schema.test.ts 與 route 測試（MIL-206）';

const registryFunctions: Record<string, RegistryFunctionCase> = {
  'registry.create_mandate_request': {
    probe: null,
    reason: `業者專用，呼叫者組織必須有通過驗證的對應業別，否則 42501。${NO_OBJECT_ID}`,
    disclosure: {
      kind: 'none',
      reason:
        '寫入函式。只回傳剛建立的申請本身（ID、種類、狀態、建立與失效時間），不含碼、不含屋主或別的組織的任何資料。代填資料原樣存起來，不查建號有沒有被登錄，所以回應不因別人是否登錄過同一個建號而不同',
    },
  },
  'registry.mandate_request_link_view': {
    probe: null,
    reason: `登入前可呼叫，任何脈絡。碼 256 位元，查不出別的碼。${NO_OBJECT_ID}`,
    disclosure: {
      kind: 'none',
      reason:
        '設計上回業者自己的公開資訊：業者名稱、統編與已驗證的業別（ADR-0029），給持有連結的人看，這是矩陣裡「統編」欄位的唯一例外，且沒有自然人的資料。無效的碼一律回零列，不區分原因。不含代填資料、屋主、綁定與否、物件資料',
    },
  },
  'registry.mandate_requests_for_practice': {
    probe: null,
    reason: `業者專用，只回呼叫者組織自己的申請，別的組織的申請與不存在的申請都回零列。${NO_OBJECT_ID}`,
    disclosure: {
      kind: 'none',
      reason:
        '只回業者自己建立的申請與代填資料。不回屋主組織、綁定與確認的時間，所以屋主打開連結、登入、綁定但沒送出，業者讀到的內容逐位元相同。不含屋主的 email 與名稱、證號、統編以外的個資',
    },
  },
  'registry.expire_mandate_requests': {
    probe: null,
    reason: `清除失效申請的代填資料。只回被清掉的檔案 key，不帶申請 ID。p_now 不得晚於資料庫時間，不能靠傳未來的時間清掉還沒失效的資料。${NO_OBJECT_ID}`,
    disclosure: {
      kind: 'none',
      reason: '只回被清掉的謄本檔案 key（不含申請 ID、組織與個資），讓呼叫端把檔案從 FileStore 刪除',
    },
  },
};

export const mandateRequestsRls: RlsRegistration = { registryTables, registryFunctions, definerOnlyTables };
