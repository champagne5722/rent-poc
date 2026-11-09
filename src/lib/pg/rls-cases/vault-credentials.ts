// vault schema 的證據檔中繼資料。
import type { DefinerOnlyTable, RlsRegistration } from './types';

const definerOnlyTables: Record<string, DefinerOnlyTable> = {
  'vault.credential_evidence': { reason: '證據檔的中繼資料，檔案本體在 FileStore。經 vault.*_credential_evidence 函式存取，開啟與刪除寫稽核事件（MIL-109）' },
};

export const vaultCredentialsRls: RlsRegistration = { definerOnlyTables };
