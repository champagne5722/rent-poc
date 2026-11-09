import { describe, expect, it } from 'vitest';
import { detectEvidenceType, validateCheckForm, validateSubmission } from './rules';

const PDF = new TextEncoder().encode('%PDF-1.7\n內容');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

const file = (over: Partial<{ fileName: string; contentType: string; bytes: Uint8Array }> = {}) => ({
  fileName: '許可函.pdf',
  contentType: 'application/pdf',
  bytes: PDF,
  ...over,
});

describe('detectEvidenceType：看檔案開頭的位元組，不信任宣告的 content type', () => {
  it.each([
    ['PDF', PDF, 'application/pdf'],
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPG, 'image/jpeg'],
  ])('%s', (_, bytes, expected) => {
    expect(detectEvidenceType(bytes)).toBe(expected);
  });

  it('其他內容回 null', () => {
    expect(detectEvidenceType(new TextEncoder().encode('<html>'))).toBeNull();
    expect(detectEvidenceType(new Uint8Array())).toBeNull();
  });
});

describe('validateSubmission', () => {
  const base = { kind: 'management', permitNo: ' 北市租管字第 123 號 ', files: [file()] };

  it('合法的送件：字號去掉前後空白，業別與檔案原樣帶出', () => {
    expect(validateSubmission(base)).toEqual({
      ok: true,
      value: { kind: 'management', permitNo: '北市租管字第 123 號', files: [file()] },
    });
  });

  it.each([
    [{ kind: 'unknown' }, 'kind'],
    [{ kind: undefined }, 'kind'],
    [{ permitNo: '   ' }, 'permitNo'],
    [{ permitNo: 'x'.repeat(61) }, 'permitNo'],
    [{ files: [] }, 'files'],
  ])('欄位錯誤 %j 指出 %s', (over, field) => {
    const result = validateSubmission({ ...base, ...over });
    expect(result).toMatchObject({ ok: false, field });
  });

  it('檔案超過 5 個、單檔超過 10 MB、內容不是 PDF 或圖片，各自被擋', () => {
    expect(validateSubmission({ ...base, files: Array.from({ length: 6 }, () => file()) })).toMatchObject({ ok: false, field: 'files' });
    expect(validateSubmission({ ...base, files: [file({ bytes: new Uint8Array(10 * 1024 * 1024 + 1) })] })).toMatchObject({ ok: false, field: 'files' });
    expect(validateSubmission({ ...base, files: [file({ bytes: new TextEncoder().encode('<script>') })] })).toMatchObject({ ok: false, field: 'files' });
  });

  it('宣告 PDF 但內容是 PNG：以內容為準，content type 改成 image/png', () => {
    const result = validateSubmission({ ...base, files: [file({ bytes: PNG, contentType: 'application/pdf', fileName: 'a.pdf' })] });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.files[0].contentType).toBe('image/png');
  });

  it('檔名去掉路徑，過長截到 120 字', () => {
    const result = validateSubmission({ ...base, files: [file({ fileName: '../../etc/' + 'a'.repeat(200) + '.pdf' })] });
    expect(result.ok && result.value.files[0].fileName.length).toBeLessThanOrEqual(120);
    expect(result.ok && result.value.files[0].fileName).not.toContain('/');
  });
});

describe('validateCheckForm', () => {
  const base = {
    channel: 'gcis_manual',
    querySource: '商工登記公示資料查詢',
    result: 'match',
    note: '',
    businessItemCodes: ['H706011', 'H703100'],
    registrationStatus: '核准設立',
  };

  it('相符：營業項目代碼轉大寫去重，登記狀態去空白', () => {
    const result = validateCheckForm({ ...base, businessItemCodes: ['h706011', ' H706011 ', 'H703100'], registrationStatus: ' 核准設立 ' });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.businessItemCodes).toEqual(['H706011', 'H703100']);
      expect(result.value.registrationStatus).toBe('核准設立');
    }
  });

  it('核對管道只收三種第一版的值', () => {
    expect(validateCheckForm({ ...base, channel: 'gcis_api' })).toMatchObject({ ok: false, field: 'channel' });
    for (const channel of ['gcis_manual', 'resim_manual', 'document_review']) {
      expect(validateCheckForm({ ...base, channel })).toMatchObject({ ok: true });
    }
  });

  it('查詢的頁別必填；結果只收四種', () => {
    expect(validateCheckForm({ ...base, querySource: ' ' })).toMatchObject({ ok: false, field: 'querySource' });
    expect(validateCheckForm({ ...base, result: 'maybe' })).toMatchObject({ ok: false, field: 'result' });
  });

  it('不是相符時必須寫判定理由；相符時可以不寫', () => {
    expect(validateCheckForm({ ...base, result: 'mismatch', note: '  ' })).toMatchObject({ ok: false, field: 'note' });
    expect(validateCheckForm({ ...base, result: 'not_found', note: '查無此證字號' })).toMatchObject({ ok: true });
  });

  it('相符時登記狀態必填；不符時可以不填', () => {
    expect(validateCheckForm({ ...base, registrationStatus: '' })).toMatchObject({ ok: false, field: 'registrationStatus' });
    const result = validateCheckForm({ ...base, result: 'mismatch', note: 'x', registrationStatus: undefined, businessItemCodes: undefined });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.registrationStatus).toBeNull();
      expect(result.value.businessItemCodes).toBeNull();
    }
  });

  it('營業項目代碼格式：1 個英文字母加 6 碼數字', () => {
    expect(validateCheckForm({ ...base, businessItemCodes: ['H70601'] })).toMatchObject({ ok: false, field: 'businessItemCodes' });
    expect(validateCheckForm({ ...base, businessItemCodes: 'H706011' })).toMatchObject({ ok: false, field: 'businessItemCodes' });
  });
});
