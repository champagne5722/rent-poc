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
  'registry.claim_mandate_request': {
    probe: null,
    reason: `屋主組織專用，業者與平台組織一律回 not_owner，不論碼有沒有效。已被別的組織綁定、過期、已送出、已收回、查無此碼，一律回 unavailable。${NO_OBJECT_ID}`,
    disclosure: {
      kind: 'none',
      reason: '寫入函式。只回結果代碼與呼叫者自己綁定的申請 ID，不含業者以外的任何資料，也不區分碼無效的原因',
    },
  },
  'registry.mandate_requests_for_owner': {
    probe: null,
    reason: `屋主組織專用，只回 owner_org_id 等於呼叫者組織的申請。沒綁定的連結、別的屋主組織的申請與不存在的申請都回零列。${NO_OBJECT_ID}`,
    disclosure: {
      kind: 'none',
      reason:
        '回綁定的屋主組織自己的申請：業者名稱與統編（業者自己的公開資訊，且屋主已用連結看過）、已驗證的業別、業者代填的資料。不回業者端的建立者、別的申請或業者的任何自然人資料，不回謄本的檔案 key',
    },
  },
  'registry.mandate_request_transcript_for_owner': {
    probe: null,
    reason: `屋主組織專用，只回呼叫者組織綁定、待屋主確認、沒失效而且有代傳謄本的申請，其餘回零列。${NO_OBJECT_ID}`,
    disclosure: {
      kind: 'none',
      reason: '回業者代傳謄本的檔案 key 與謄本表單欄位，給伺服器端轉成屋主組織的謄本，route 不得回給前端。不含業者的個資',
    },
  },
  'registry.confirm_mandate_request_draft': {
    probe: null,
    reason: `屋主組織專用，申請必須是呼叫者組織綁定的，租賃單位必須是呼叫者組織自己的。${NO_OBJECT_ID}`,
    disclosure: {
      kind: 'none',
      reason: '寫入函式。只回結果代碼與呼叫者自己的租賃單位 ID。不改 draft，所以業者端看到的申請不因屋主確認而改變',
    },
  },
  'registry.submit_mandate_request': {
    probe: null,
    reason: `屋主組織專用。租賃單位被佔用的檢查只讀呼叫者組織自己的申請，別人的租賃單位與不存在的租賃單位都回 unit_not_found。${NO_OBJECT_ID}`,
    disclosure: {
      kind: 'none',
      reason:
        '寫入函式。只回結果代碼、租賃單位數量與被清掉的謄本檔案 key。units_occupied 不透露是哪一家業者，也不透露是進行中的申請、有效的委託或有效的包租。對業者組織寫入的站內通知只含申請種類與租賃單位數量',
    },
  },
  'registry.withdraw_mandate_request': {
    probe: null,
    reason: `屋主組織專用。申請還在待屋主確認時回 not_submitted，不通知業者，業者看不出屋主打開過連結。${NO_OBJECT_ID}`,
    disclosure: {
      kind: 'none',
      reason: '寫入函式。只回結果代碼。對業者組織寫入的站內通知只含「申請已收回」與申請種類，不寫原因，不帶屋主的任何資料',
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
