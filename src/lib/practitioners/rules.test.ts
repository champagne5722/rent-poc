import { describe, expect, it } from 'vitest';
import {
  certificateKey,
  formatCertificateNumber,
  maskCertificateNumber,
  validateCertificateCheckForm,
  validateCertificateForm,
  validateConsentCheckForm,
  validateConsentUpload,
  validateEmploymentCheckForm,
  validateEmploymentForm,
} from './rules';

const TODAY = '2026-11-09';
const pdf = { fileName: '證書.pdf', contentType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.7\nx') };
const valid = {
  certificateKind: 'rental_housing_manager',
  certYear: '112',
  certWord: '內授營',
  certSerial: '123456',
  issuedOn: '2024-03-01',
  validUntil: '2028-03-01',
  files: [pdf],
};

describe('證號格式', () => {
  const no = { year: '112', word: '內授營', serial: '123456' };
  it('顯示格式、遮罩與資料庫比對用的 key', () => {
    expect(formatCertificateNumber(no)).toBe('112年內授營字第123456號');
    expect(maskCertificateNumber(no)).toBe('112年內授營字第***456號');
    expect(certificateKey('rental_housing_manager', no)).toBe('rental_housing_manager:112:內授營:123456');
  });
  it('序號不足 3 碼時整串保留，不補星號', () => {
    expect(maskCertificateNumber({ year: '99', word: '字', serial: '12' })).toBe('99年字字第12號');
  });
});

describe('證書登錄表單', () => {
  it('證號三段、種類、發證日、效期、影本都齊全時通過，到職日預設今天', () => {
    const result = validateCertificateForm(valid, TODAY);
    expect(result).toMatchObject({ ok: true, value: { kind: 'rental_housing_manager', number: { year: '112', word: '內授營', serial: '123456' }, startedOn: TODAY } });
  });

  it.each([
    ['certificateKind', { certificateKind: 'other' }],
    ['certYear', { certYear: '1' }],
    ['certWord', { certWord: ' ' }],
    ['certSerial', { certSerial: 'abc' }],
    ['issuedOn', { issuedOn: '' }],
    ['validUntil', { validUntil: '' }],
    ['files', { files: [] }],
  ])('缺或錯 %s 時回報該欄位', (field, over) => {
    expect(validateCertificateForm({ ...valid, ...over }, TODAY)).toMatchObject({ ok: false, field });
  });

  it('發證日不得晚於今天，效期必須晚於發證日', () => {
    expect(validateCertificateForm({ ...valid, issuedOn: '2026-11-10' }, TODAY)).toMatchObject({ ok: false, field: 'issuedOn' });
    expect(validateCertificateForm({ ...valid, validUntil: '2024-03-01' }, TODAY)).toMatchObject({ ok: false, field: 'validUntil' });
  });

  it('效期與發證日加 4 年不一致時不擋（只提示）', () => {
    expect(validateCertificateForm({ ...valid, validUntil: '2027-03-01' }, TODAY).ok).toBe(true);
  });

  it('影本看檔案開頭判斷類型，不信任宣告的 content type', () => {
    const fake = { fileName: 'x.pdf', contentType: 'application/pdf', bytes: new TextEncoder().encode('not a pdf') };
    expect(validateCertificateForm({ ...valid, files: [fake] }, TODAY)).toMatchObject({ ok: false, field: 'files' });
  });
});

describe('任職與同意書上傳', () => {
  it('到職日預設今天，格式錯誤時擋下', () => {
    expect(validateEmploymentForm({}, TODAY)).toEqual({ ok: true, value: { startedOn: TODAY } });
    expect(validateEmploymentForm({ startedOn: '2026/11/09' }, TODAY)).toMatchObject({ ok: false, field: 'startedOn' });
  });
  it('同意書至少一個檔案', () => {
    expect(validateConsentUpload({ files: [] })).toMatchObject({ ok: false, field: 'files' });
    expect(validateConsentUpload({ files: [pdf] }).ok).toBe(true);
  });
});

describe('審核台核對表單', () => {
  const base = { channel: 'resim_manual', querySource: 'resim 證書查詢', result: 'match', note: '' };
  it('證書相符時必須登錄效期', () => {
    expect(validateCertificateCheckForm(base)).toMatchObject({ ok: false, field: 'validUntil' });
    expect(validateCertificateCheckForm({ ...base, validUntil: '2028-03-01' })).toMatchObject({ ok: true, value: { validUntil: '2028-03-01' } });
  });
  it('不是相符時判定理由必填，效期丟掉', () => {
    expect(validateCertificateCheckForm({ ...base, result: 'not_found' })).toMatchObject({ ok: false, field: 'note' });
    expect(validateCertificateCheckForm({ ...base, result: 'not_found', note: 'resim 查無此證號', validUntil: '2028-03-01' })).toMatchObject({
      ok: true,
      value: { validUntil: null },
    });
  });
  it('任職核對沒有效期欄位', () => {
    expect(validateEmploymentCheckForm({ ...base, validUntil: '2028-03-01' })).toMatchObject({ ok: true, value: { validUntil: null } });
  });
  it('同意書核對的效期選填，填了要是日期', () => {
    expect(validateConsentCheckForm({ ...base, channel: 'document_review' })).toMatchObject({ ok: true, value: { validUntil: null } });
    expect(validateConsentCheckForm({ ...base, validUntil: '明年' })).toMatchObject({ ok: false, field: 'validUntil' });
  });
  it('核對管道只有第一版的三種', () => {
    expect(validateEmploymentCheckForm({ ...base, channel: 'gcis_api' })).toMatchObject({ ok: false, field: 'channel' });
  });
});
