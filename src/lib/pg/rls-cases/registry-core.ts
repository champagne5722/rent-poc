// registry 的物件（anchors 表）、租賃單位、編碼參照表與相關函式（MIL-81、143、145、196）。
// 這些函式處理產權資料，不回傳執業人員個資，disclosure 一律登記為「不揭露」（MIL-165）。
import { newUlid } from '../ulid';
import type { DefinerOnlyTable, RegistryFunctionCase, RegistryTableCase, RlsRegistration } from './types';

const registryTables: Record<string, RegistryTableCase> = {
  'registry.anchors': { purpose: '物件' },
  'registry.rental_units': { purpose: '租賃單位' },
  'registry.areas': { purpose: '縣市與鄉鎮市區編碼表（參照）' },
  'registry.sections': { purpose: '段碼表（參照）' },
  // MIL-144
  'registry.platform_settings': { purpose: '平台設定值。目前只有每個組織 24 小時內的撞號次數設定值，超過時只通知營運者，只經補建號函式讀取' },
};

const registryFunctions: Record<string, RegistryFunctionCase> = {
  'registry.create_pending_anchor': {
    probe: null,
    reason: '呼叫端自己給新 ID，只建不讀，沒有可探測的目標',
    disclosure: { kind: 'none', reason: '寫入函式，只回呼叫端自己給的錨點 ID 與單位 ID' },
  },
  'registry.assign_anchor_key': {
    probe: (tx, { anchorId }) =>
      tx.query('SELECT * FROM registry.assign_anchor_key($1, $2, $3, $4, $5, NULL, $6, $7)', [anchorId, 'A', '01', '0001', '1', newUlid(), newUlid()]),
    reason: '以物件 ID 補建號與修正建號，呼叫者組織沒有營運資料指向該物件就失敗，與物件不存在的錯誤相同',
    disclosure: {
      kind: 'none',
      reason:
        '寫入函式（MIL-144、MIL-196）。回傳結果代碼、呼叫者自己提出的審核單號、呼叫者自己組織的物件 ID。撞到別的組織時不回對方的任何資料，對外的呼叫端把「鍵沒人用」與「撞到別的組織」當成同一種結果。不含執業人員資料',
    },
  },
  'registry.get_anchors_for_units': {
    probe: async (tx, { unitId }) =>
      (await tx.query('SELECT * FROM registry.get_anchors_for_units($1::text[])', [[unitId]])).rows,
    reason: '以單位 ID 讀物件的建號。撞號時回呼叫者宣稱的鍵',
    disclosure: { kind: 'none', reason: '回傳呼叫者組織自己的物件建號（地段、建號、座標），撞號時只讀呼叫者自己提出的宣稱，隔離由上面的 probe 驗證。不含執業人員資料' },
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
  // MIL-202
  'registry.get_unit_groups': {
    probe: async (tx, { unitId }) => (await tx.query('SELECT * FROM registry.get_unit_groups($1::text[])', [[unitId]])).rows,
    reason: '以單位 ID 讀單位對存續單位與分組鍵，物件列表依物件分組用。呼叫者組織沒有物件指向的單位得到空結果',
    disclosure: {
      kind: 'none',
      reason:
        '只回呼叫者組織自己的單位 ID，加上存續單位與存續錨點 ID 的 md5。存續單位可能屬於別的組織，所以不回原始 ID，只能比對相同或不同。隔離由上面的 probe 驗證。不含執業人員資料',
    },
  },
  'registry.get_sibling_units': {
    probe: async (tx, { unitId }) => (await tx.query('SELECT * FROM registry.get_sibling_units($1)', [unitId])).rows,
    reason: '以單位 ID 讀同一錨點下呼叫者組織的單位',
    disclosure: { kind: 'none', reason: '回傳呼叫者組織自己的同錨點單位，隔離由上面的 probe 驗證。不含執業人員資料' },
  },
};

const definerOnlyTables: Record<string, DefinerOnlyTable> = {
  'registry.anchors': { reason: '物件，全域一份。經 registry.create_pending_anchor 等函式存取（MIL-81）' },
  'registry.rental_units': { reason: '租賃單位，全域一份。經 registry.create_pending_anchor 等函式存取（MIL-81）' },
  'registry.areas': { reason: '縣市與鄉鎮市區編碼表（參照）。執行期不讀，seed 檔由 migration 載入（MIL-143）' },
  'registry.sections': { reason: '段碼表（參照）。執行期不讀，seed 檔由 migration 載入（MIL-143）' },
  'registry.platform_settings': { reason: '平台設定值（MIL-144）。app_rw 沒有任何權限，補建號函式在資料庫內讀取，呼叫端不能自己改設定值' },
};

export const registryCoreRls: RlsRegistration = { registryTables, registryFunctions, definerOnlyTables };
