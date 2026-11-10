// registry 的產權錨點、租賃單位、編碼參照表與相關函式（MIL-81、143、145）。
// 這些函式處理產權資料，不回傳執業人員個資，disclosure 一律登記為「不揭露」（MIL-165）。
import { newUlid } from '../ulid';
import type { DefinerOnlyTable, RegistryFunctionCase, RegistryTableCase, RlsRegistration } from './types';

const registryTables: Record<string, RegistryTableCase> = {
  'registry.anchors': { purpose: '產權錨點' },
  'registry.rental_units': { purpose: '租賃單位' },
  'registry.areas': { purpose: '縣市與鄉鎮市區編碼表（參照）' },
  'registry.sections': { purpose: '段碼表（參照）' },
  // MIL-144
  'registry.platform_settings': { purpose: '平台設定值。目前只有每個組織 24 小時內的撞號回應上限，只經撞號函式讀取' },
};

const registryFunctions: Record<string, RegistryFunctionCase> = {
  'registry.create_pending_anchor': {
    probe: null,
    reason: '呼叫端自己給新 ID，只建不讀，沒有可探測的目標',
    disclosure: { kind: 'none', reason: '寫入函式，只回呼叫端自己給的錨點 ID 與單位 ID' },
  },
  'registry.assign_anchor_key': {
    probe: (tx, { anchorId }) =>
      tx.query('SELECT * FROM registry.assign_anchor_key($1, $2, $3, $4, $5, NULL, $6)', [anchorId, 'A', '01', '0001', '1', newUlid()]),
    reason: '以錨點 ID 補建號，呼叫者組織沒有物件指向該錨點就失敗，與錨點不存在的錯誤相同',
    disclosure: {
      kind: 'none',
      reason:
        '寫入函式（MIL-144）。回傳結果代碼、呼叫者自己提出的審核單號、呼叫者自己組織的物件 ID。撞到別的組織時不回對方的任何資料。不含執業人員資料',
    },
  },
  // MIL-144
  'registry.record_collision_limit_hit': {
    probe: null,
    reason: '不接收別人能猜的 ID：只寫呼叫者自己組織的審核台項目，額度沒用完就拒絕',
    disclosure: { kind: 'none', reason: '寫入函式，回傳呼叫者自己組織的審核項目 ID。不含執業人員資料' },
  },
  'registry.get_collision_reviews': {
    probe: async (tx, { unitId }) => (await tx.query('SELECT * FROM registry.get_collision_reviews($1::text[])', [[unitId]])).rows,
    reason: '以單位 ID 讀呼叫者組織自己提出的待審撞號項目',
    disclosure: { kind: 'none', reason: '只回呼叫者組織自己提出的審核單號與建立時間，隔離由上面的 probe 驗證。不含執業人員資料' },
  },
  'registry.get_anchors_for_units': {
    probe: async (tx, { unitId }) =>
      (await tx.query('SELECT * FROM registry.get_anchors_for_units($1::text[])', [[unitId]])).rows,
    reason: '以單位 ID 讀錨點',
    disclosure: { kind: 'none', reason: '回傳呼叫者組織自己的產權錨點（地段、建號、座標），隔離由上面的 probe 驗證。不含執業人員資料' },
  },
  // MIL-145
  'registry.create_sublet_unit': {
    probe: (tx, { unitId }) => tx.query('SELECT * FROM registry.create_sublet_unit($1, $2, $3, NULL)', [unitId, newUlid(), '301']),
    reason: '以來源單位 ID 在同一錨點下新增分租單位，來源不是呼叫者組織的就失敗',
    disclosure: { kind: 'none', reason: '寫入函式，回傳錨點 ID、單位 ID 與後綴' },
  },
  'registry.get_unit_details': {
    probe: async (tx, { unitId }) => (await tx.query('SELECT * FROM registry.get_unit_details($1::text[])', [[unitId]])).rows,
    reason: '以單位 ID 讀單位資料與顯示編碼要用的編碼',
    disclosure: { kind: 'none', reason: '回傳呼叫者組織自己的租賃單位資料，隔離由上面的 probe 驗證。不含執業人員資料' },
  },
  'registry.get_sibling_units': {
    probe: async (tx, { unitId }) => (await tx.query('SELECT * FROM registry.get_sibling_units($1)', [unitId])).rows,
    reason: '以單位 ID 讀同一錨點下呼叫者組織的單位',
    disclosure: { kind: 'none', reason: '回傳呼叫者組織自己的同錨點單位，隔離由上面的 probe 驗證。不含執業人員資料' },
  },
};

const definerOnlyTables: Record<string, DefinerOnlyTable> = {
  'registry.anchors': { reason: '產權錨點，全域一份。經 registry.create_pending_anchor 等函式存取（MIL-81）' },
  'registry.rental_units': { reason: '租賃單位，全域一份。經 registry.create_pending_anchor 等函式存取（MIL-81）' },
  'registry.areas': { reason: '縣市與鄉鎮市區編碼表（參照）。執行期不讀，seed 檔由 migration 載入（MIL-143）' },
  'registry.sections': { reason: '段碼表（參照）。執行期不讀，seed 檔由 migration 載入（MIL-143）' },
  'registry.platform_settings': { reason: '平台設定值（MIL-144）。app_rw 沒有任何權限，撞號函式在資料庫內讀取，呼叫端不能自己放寬上限' },
};

export const registryCoreRls: RlsRegistration = { registryTables, registryFunctions, definerOnlyTables };
