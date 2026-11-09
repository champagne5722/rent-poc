// registry 的產權錨點、租賃單位、編碼參照表與相關函式（MIL-81、143、145）。
import { newUlid } from '../ulid';
import type { DefinerOnlyTable, RegistryFunctionCase, RegistryTableCase, RlsRegistration } from './types';

const registryTables: Record<string, RegistryTableCase> = {
  'registry.anchors': { purpose: '產權錨點' },
  'registry.rental_units': { purpose: '租賃單位' },
  'registry.areas': { purpose: '縣市與鄉鎮市區編碼表（參照）' },
  'registry.sections': { purpose: '段碼表（參照）' },
};

const registryFunctions: Record<string, RegistryFunctionCase> = {
  'registry.create_pending_anchor': {
    probe: null,
    reason: '呼叫端自己給新 ID，只建不讀，沒有可探測的目標',
  },
  'registry.assign_anchor_key': {
    probe: (tx, { anchorId }) =>
      tx.query('SELECT registry.assign_anchor_key($1, $2, $3, $4, $5, NULL)', [anchorId, 'A', '01', '0001', '1']),
    reason: '以錨點 ID 補建號',
  },
  'registry.get_anchors_for_units': {
    probe: async (tx, { unitId }) =>
      (await tx.query('SELECT * FROM registry.get_anchors_for_units($1::text[])', [[unitId]])).rows,
    reason: '以單位 ID 讀錨點',
  },
  // MIL-145
  'registry.create_sublet_unit': {
    probe: (tx, { unitId }) => tx.query('SELECT * FROM registry.create_sublet_unit($1, $2, $3, NULL)', [unitId, newUlid(), '301']),
    reason: '以來源單位 ID 在同一錨點下新增分租單位，來源不是呼叫者組織的就失敗',
  },
  'registry.get_unit_details': {
    probe: async (tx, { unitId }) => (await tx.query('SELECT * FROM registry.get_unit_details($1::text[])', [[unitId]])).rows,
    reason: '以單位 ID 讀單位資料與顯示編碼要用的編碼',
  },
  'registry.get_sibling_units': {
    probe: async (tx, { unitId }) => (await tx.query('SELECT * FROM registry.get_sibling_units($1)', [unitId])).rows,
    reason: '以單位 ID 讀同一錨點下呼叫者組織的單位',
  },
};

const definerOnlyTables: Record<string, DefinerOnlyTable> = {
  'registry.anchors': { reason: '產權錨點，全域一份。經 registry.create_pending_anchor 等函式存取（MIL-81）' },
  'registry.rental_units': { reason: '租賃單位，全域一份。經 registry.create_pending_anchor 等函式存取（MIL-81）' },
  'registry.areas': { reason: '縣市與鄉鎮市區編碼表（參照）。執行期不讀，seed 檔由 migration 載入（MIL-143）' },
  'registry.sections': { reason: '段碼表（參照）。執行期不讀，seed 檔由 migration 載入（MIL-143）' },
};

export const registryCoreRls: RlsRegistration = { registryTables, registryFunctions, definerOnlyTables };
