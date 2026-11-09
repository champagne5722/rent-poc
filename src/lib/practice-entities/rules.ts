// 執業主體送件與審核台核對表單的欄位規則（MIL-109）。純函式，沒有 I/O。
// 業別資格、狀態轉移、登記狀態失效的判定在 src/lib/registry-rules，這裡只驗證表單欄位的形狀。

import { LICENSE_KINDS, type LicenseKind } from '../registry-rules';

export const PERMIT_NO_MAX = 60;
export const EVIDENCE_MAX_FILES = 5;
export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_NAME_MAX = 120;

export type EvidenceContentType = 'application/pdf' | 'image/png' | 'image/jpeg';

/** 證據檔的副檔名，組 FileStore key 用。 */
export const EVIDENCE_EXTENSIONS: Record<EvidenceContentType, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

export interface EvidenceUpload {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface CheckedEvidenceUpload extends EvidenceUpload {
  contentType: EvidenceContentType;
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) => prefix.every((b, i) => bytes[i] === b);

/** 看檔案開頭的位元組判斷類型，不信任瀏覽器宣告的 content type。 */
export function detectEvidenceType(bytes: Uint8Array): EvidenceContentType | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf'; // %PDF
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  return null;
}

type Fail<F extends string> = { ok: false; field: F; message: string };
const fail = <F extends string>(field: F, message: string): Fail<F> => ({ ok: false, field, message });

export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const trimmed = base.trim().replace(/[\u0000-\u001f]/g, '');
  return (trimmed === '' ? '證據檔' : trimmed).slice(-FILE_NAME_MAX);
}

export type SubmissionField = 'kind' | 'permitNo' | 'files';

export interface Submission {
  kind: LicenseKind;
  permitNo: string;
  files: CheckedEvidenceUpload[];
}

export function validateSubmission(input: {
  kind?: unknown;
  permitNo?: unknown;
  files?: unknown;
}): { ok: true; value: Submission } | Fail<SubmissionField> {
  if (!(LICENSE_KINDS as readonly unknown[]).includes(input.kind)) return fail('kind', '請選擇業別');
  const kind = input.kind as LicenseKind;

  const permitNo = typeof input.permitNo === 'string' ? input.permitNo.trim() : '';
  if (permitNo === '') return fail('permitNo', '請輸入許可或登記證字號');
  if (permitNo.length > PERMIT_NO_MAX) return fail('permitNo', `字號不得超過 ${PERMIT_NO_MAX} 字`);

  const files = Array.isArray(input.files) ? (input.files as EvidenceUpload[]) : [];
  if (files.length === 0) return fail('files', '請上傳至少一個證明文件');
  if (files.length > EVIDENCE_MAX_FILES) return fail('files', `一次最多上傳 ${EVIDENCE_MAX_FILES} 個檔案`);

  const checked: CheckedEvidenceUpload[] = [];
  for (const file of files) {
    if (file.bytes.length > EVIDENCE_MAX_BYTES) return fail('files', `單一檔案不得超過 ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB`);
    const detected = detectEvidenceType(file.bytes);
    if (!detected) return fail('files', '證明文件必須是 PDF、PNG 或 JPEG');
    checked.push({ fileName: cleanFileName(file.fileName), contentType: detected, bytes: file.bytes });
  }
  return { ok: true, value: { kind, permitNo, files: checked } };
}

// ---------------------------------------------------------------------------
// 審核台核對表單（ADR-0017 決議 10）

/** 第一版的核對管道。gcis_api、resim_batch 等 MIL-49 與地政司核准後再開。 */
export const MANUAL_CHANNELS = ['gcis_manual', 'resim_manual', 'document_review'] as const;
export type ManualChannel = (typeof MANUAL_CHANNELS)[number];

export const CHECK_RESULTS = ['match', 'mismatch', 'not_found', 'revoked'] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

export const BUSINESS_ITEM_CODE_PATTERN = /^[A-Z][0-9]{6}$/;
export const NOTE_MAX = 500;
export const QUERY_SOURCE_MAX = 120;
export const REGISTRATION_STATUS_MAX = 40;

export type CheckField = 'channel' | 'querySource' | 'result' | 'note' | 'businessItemCodes' | 'registrationStatus';

export interface CheckForm {
  channel: ManualChannel;
  querySource: string;
  result: CheckResult;
  note: string;
  /** null 代表這次不更新營業項目。 */
  businessItemCodes: string[] | null;
  /** null 代表這次不更新登記狀態。 */
  registrationStatus: string | null;
}

/**
 * 平台營運者在核對表單填的欄位。
 * 相符時登記狀態必填，因為 P0-03 AC2 的判定時點是營運者登錄營業項目時（ADR-0017 Consequences）。
 * 不是相符時判定理由必填，執業主體靠它補件。
 */
export function validateCheckForm(input: {
  channel?: unknown;
  querySource?: unknown;
  result?: unknown;
  note?: unknown;
  businessItemCodes?: unknown;
  registrationStatus?: unknown;
}): { ok: true; value: CheckForm } | Fail<CheckField> {
  if (!(MANUAL_CHANNELS as readonly unknown[]).includes(input.channel)) return fail('channel', '請選擇核對管道');
  const channel = input.channel as ManualChannel;

  const querySource = typeof input.querySource === 'string' ? input.querySource.trim() : '';
  if (querySource === '') return fail('querySource', '請填查詢的頁別');
  if (querySource.length > QUERY_SOURCE_MAX) return fail('querySource', `查詢頁別不得超過 ${QUERY_SOURCE_MAX} 字`);

  if (!(CHECK_RESULTS as readonly unknown[]).includes(input.result)) return fail('result', '請選擇核對結果');
  const result = input.result as CheckResult;

  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (result !== 'match' && note === '') return fail('note', '核對結果不是相符時，請寫判定理由，執業主體靠它補件');
  if (note.length > NOTE_MAX) return fail('note', `判定理由不得超過 ${NOTE_MAX} 字`);

  let businessItemCodes: string[] | null = null;
  if (input.businessItemCodes !== undefined && input.businessItemCodes !== null) {
    if (!Array.isArray(input.businessItemCodes)) return fail('businessItemCodes', '營業項目必須是代碼清單');
    const codes = new Set<string>();
    for (const raw of input.businessItemCodes) {
      const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
      if (!BUSINESS_ITEM_CODE_PATTERN.test(code)) return fail('businessItemCodes', `營業項目代碼格式是 1 個英文字母加 6 碼數字，例如 H706011：${String(raw)}`);
      codes.add(code);
    }
    businessItemCodes = [...codes];
  }

  let registrationStatus: string | null = null;
  if (typeof input.registrationStatus === 'string' && input.registrationStatus.trim() !== '') {
    registrationStatus = input.registrationStatus.trim();
    if (registrationStatus.length > REGISTRATION_STATUS_MAX) return fail('registrationStatus', `登記狀態不得超過 ${REGISTRATION_STATUS_MAX} 字`);
  }
  if (result === 'match' && registrationStatus === null) return fail('registrationStatus', '相符時請填商工登記的登記狀態');
  if (result === 'match' && businessItemCodes === null) return fail('businessItemCodes', '相符時請登錄商工登記的營業項目');

  return { ok: true, value: { channel, querySource, result, note, businessItemCodes, registrationStatus } };
}
