// 執業人員證書登錄與審核台核對表單的欄位規則（MIL-111）。純函式，沒有 I/O。
// 專任判定、狀態轉移、valid_until 預填與標章在 src/lib/registry-rules，這裡只驗證表單欄位的形狀與證號格式。

import { CERTIFICATE_KINDS, isIsoDate, type CertificateKind } from '../registry-rules';
import {
  CHECK_RESULTS,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_FILES,
  MANUAL_CHANNELS,
  NOTE_MAX,
  QUERY_SOURCE_MAX,
  cleanFileName,
  detectEvidenceType,
  type CheckResult,
  type CheckedEvidenceUpload,
  type EvidenceUpload,
  type ManualChannel,
} from '../practice-entities/rules';

export const CERT_YEAR_PATTERN = /^[0-9]{2,4}$/;
export const CERT_SERIAL_PATTERN = /^[0-9]{1,10}$/;
export const CERT_WORD_MAX = 20;

export interface CertificateNumber {
  year: string;
  word: string;
  serial: string;
}

/** 證號的顯示格式：112年內授營字第123456號。 */
export function formatCertificateNumber(no: CertificateNumber): string {
  return `${no.year}年${no.word}字第${no.serial}號`;
}

/** 列表與給屋主的畫面遮罩證號：只留序號最後 3 碼。 */
export function maskCertificateNumber(no: CertificateNumber): string {
  const tail = no.serial.slice(-3);
  return `${no.year}年${no.word}字第${'*'.repeat(Math.max(0, no.serial.length - tail.length))}${tail}號`;
}

/** 資料庫的 certificate_key：證書種類:年:字:號。同一證號在不同組織登錄時用它比對。 */
export function certificateKey(kind: CertificateKind, no: CertificateNumber): string {
  return `${kind}:${no.year}:${no.word}:${no.serial}`;
}

type Fail<F extends string> = { ok: false; field: F; message: string };
const fail = <F extends string>(field: F, message: string): Fail<F> => ({ ok: false, field, message });

function checkFiles(raw: unknown, required: boolean): { ok: true; files: CheckedEvidenceUpload[] } | Fail<'files'> {
  const files = Array.isArray(raw) ? (raw as EvidenceUpload[]) : [];
  if (files.length === 0) return required ? fail('files', '請上傳至少一個檔案') : { ok: true, files: [] };
  if (files.length > EVIDENCE_MAX_FILES) return fail('files', `一次最多上傳 ${EVIDENCE_MAX_FILES} 個檔案`);
  const checked: CheckedEvidenceUpload[] = [];
  for (const file of files) {
    if (file.bytes.length > EVIDENCE_MAX_BYTES) return fail('files', `單一檔案不得超過 ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB`);
    const detected = detectEvidenceType(file.bytes);
    if (!detected) return fail('files', '檔案必須是 PDF、PNG 或 JPEG');
    checked.push({ fileName: cleanFileName(file.fileName), contentType: detected, bytes: file.bytes });
  }
  return { ok: true, files: checked };
}

// ---------------------------------------------------------------------------
// 證書登錄表單

export type CertificateField = 'certificateKind' | 'certYear' | 'certWord' | 'certSerial' | 'issuedOn' | 'validUntil' | 'startedOn' | 'files';

export interface CertificateForm {
  kind: CertificateKind;
  number: CertificateNumber;
  issuedOn: string;
  validUntil: string;
  /** 到職日。沒填就是今天。 */
  startedOn: string;
  files: CheckedEvidenceUpload[];
}

/**
 * 證書登錄表單（P0-04 欄位、P0-24 AC3）。證號三段、證書種類、發證日、效期必填。
 * 效期與發證日加 4 年不一致只提示，不在這裡擋（checkValidUntilConsistency）。
 * @param today 今天的台灣日期，YYYY-MM-DD。
 */
export function validateCertificateForm(
  input: {
    certificateKind?: unknown;
    certYear?: unknown;
    certWord?: unknown;
    certSerial?: unknown;
    issuedOn?: unknown;
    validUntil?: unknown;
    startedOn?: unknown;
    files?: unknown;
  },
  today: string,
): { ok: true; value: CertificateForm } | Fail<CertificateField> {
  if (!(CERTIFICATE_KINDS as readonly unknown[]).includes(input.certificateKind)) return fail('certificateKind', '請選擇證書種類');
  const kind = input.certificateKind as CertificateKind;

  const year = typeof input.certYear === 'string' ? input.certYear.trim() : '';
  if (!CERT_YEAR_PATTERN.test(year)) return fail('certYear', '證號的年請填 2 到 4 位數字');
  const word = typeof input.certWord === 'string' ? input.certWord.trim() : '';
  if (word === '') return fail('certWord', '請填證號的字');
  if (word.length > CERT_WORD_MAX) return fail('certWord', `證號的字不得超過 ${CERT_WORD_MAX} 字`);
  const serial = typeof input.certSerial === 'string' ? input.certSerial.trim() : '';
  if (!CERT_SERIAL_PATTERN.test(serial)) return fail('certSerial', '證號的號請填 1 到 10 位數字');

  const issuedOn = typeof input.issuedOn === 'string' ? input.issuedOn.trim() : '';
  if (!isIsoDate(issuedOn)) return fail('issuedOn', '請填發證日');
  if (issuedOn > today) return fail('issuedOn', '發證日不得晚於今天');
  const validUntil = typeof input.validUntil === 'string' ? input.validUntil.trim() : '';
  if (!isIsoDate(validUntil)) return fail('validUntil', '請填效期');
  if (validUntil <= issuedOn) return fail('validUntil', '效期必須晚於發證日');

  const startedRaw = typeof input.startedOn === 'string' ? input.startedOn.trim() : '';
  const startedOn = startedRaw === '' ? today : startedRaw;
  if (!isIsoDate(startedOn)) return fail('startedOn', '到職日格式不正確');

  const files = checkFiles(input.files, true);
  if (!files.ok) return files;
  return { ok: true, value: { kind, number: { year, word, serial }, issuedOn, validUntil, startedOn, files: files.files } };
}

/** 本人在目前執業主體建立任職（證書已登錄）。 */
export function validateEmploymentForm(input: { startedOn?: unknown }, today: string): { ok: true; value: { startedOn: string } } | Fail<'startedOn'> {
  const raw = typeof input.startedOn === 'string' ? input.startedOn.trim() : '';
  const startedOn = raw === '' ? today : raw;
  if (!isIsoDate(startedOn)) return fail('startedOn', '到職日格式不正確');
  return { ok: true, value: { startedOn } };
}

/** 同意書上傳：至少一個檔案。 */
export function validateConsentUpload(input: { files?: unknown }): { ok: true; value: { files: CheckedEvidenceUpload[] } } | Fail<'files'> {
  const files = checkFiles(input.files, true);
  return files.ok ? { ok: true, value: { files: files.files } } : files;
}

// ---------------------------------------------------------------------------
// 審核台核對表單（ADR-0017 決議 10）

export type CertificateCheckField = 'channel' | 'querySource' | 'result' | 'note' | 'validUntil';

export interface BaseCheckForm {
  channel: ManualChannel;
  querySource: string;
  result: CheckResult;
  note: string;
}

export interface LayerCheckForm extends BaseCheckForm {
  /** 證書：相符時必填，營運者依 resim 登錄。同意書：選填，空值代表同意書沒有載明期限。任職：永遠是 null。 */
  validUntil: string | null;
}

function validateBase(input: Record<string, unknown>): { ok: true; value: BaseCheckForm } | Fail<'channel' | 'querySource' | 'result' | 'note'> {
  if (!(MANUAL_CHANNELS as readonly unknown[]).includes(input.channel)) return fail('channel', '請選擇核對管道');
  const querySource = typeof input.querySource === 'string' ? input.querySource.trim() : '';
  if (querySource === '') return fail('querySource', '請填查詢的頁別');
  if (querySource.length > QUERY_SOURCE_MAX) return fail('querySource', `查詢頁別不得超過 ${QUERY_SOURCE_MAX} 字`);
  if (!(CHECK_RESULTS as readonly unknown[]).includes(input.result)) return fail('result', '請選擇核對結果');
  const result = input.result as CheckResult;
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (result !== 'match' && note === '') return fail('note', '核對結果不是相符時，請寫判定理由，執業人員靠它補件');
  if (note.length > NOTE_MAX) return fail('note', `判定理由不得超過 ${NOTE_MAX} 字`);
  return { ok: true, value: { channel: input.channel as ManualChannel, querySource, result, note } };
}

function validateDate(raw: unknown, required: boolean, message: string): { ok: true; value: string | null } | Fail<'validUntil'> {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return required ? fail('validUntil', message) : { ok: true, value: null };
  if (!isIsoDate(text)) return fail('validUntil', '日期格式必須是 YYYY-MM-DD');
  return { ok: true, value: text };
}

/** 證書核對：相符時必須登錄 resim 的效期（ADR-0017 決議 8）。 */
export function validateCertificateCheckForm(input: Record<string, unknown>): { ok: true; value: LayerCheckForm } | Fail<CertificateCheckField> {
  const base = validateBase(input);
  if (!base.ok) return base;
  const until = validateDate(input.validUntil, base.value.result === 'match', '相符時請登錄 resim 查到的效期');
  if (!until.ok) return until;
  return { ok: true, value: { ...base.value, validUntil: base.value.result === 'match' ? until.value : null } };
}

/** 任職核對：沒有額外欄位。 */
export function validateEmploymentCheckForm(input: Record<string, unknown>): { ok: true; value: LayerCheckForm } | Fail<CertificateCheckField> {
  const base = validateBase(input);
  return base.ok ? { ok: true, value: { ...base.value, validUntil: null } } : base;
}

/** 同意書核對：效期選填。 */
export function validateConsentCheckForm(input: Record<string, unknown>): { ok: true; value: LayerCheckForm } | Fail<CertificateCheckField> {
  const base = validateBase(input);
  if (!base.ok) return base;
  const until = validateDate(input.validUntil, false, '');
  if (!until.ok) return until;
  return { ok: true, value: { ...base.value, validUntil: base.value.result === 'match' ? until.value : null } };
}
