import { describe, expect, it } from 'vitest';
import {
  NOTICE_CATALOG,
  NOTICE_TYPES,
  currentNotice,
  findNotice,
  textSha256,
  type NoticeCatalog,
} from './notices';

// MIL-84 AC1：四種告知都是程式內常數，帶類型與版本，文字標示待法務確認。

describe('告知文字常數', () => {
  it('四種告知類型齊全', () => {
    expect([...NOTICE_TYPES].sort()).toEqual(['case_data_sharing', 'certificate_pii', 'esign', 'transcript_id_pii']);
  });

  it.each(NOTICE_TYPES)('%s：版本從 1 連續遞增，文字非空，標示待法務確認', (type) => {
    const versions = NOTICE_CATALOG[type];
    expect(versions.length).toBeGreaterThanOrEqual(1);
    versions.forEach((v, i) => {
      expect(v.version).toBe(i + 1);
      expect(v.title.trim()).not.toBe('');
      expect(v.text.trim().length).toBeGreaterThan(50);
      expect(v.legalReview).toBe('pending');
      expect(v.text).toContain('待法務確認');
    });
  });

  it('textSha256 對 UTF-8 位元組取 SHA-256，小寫十六進位（已知向量）', () => {
    expect(textSha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // 非 ASCII 文字以 UTF-8 計算。期望值由 `printf '告知' | shasum -a 256` 得出
    expect(textSha256('告知')).toBe('30cc834bfca9bbe7aefbf555c08c36be1fc02d6a56d4348ac35c2118204b6e43');
  });

  describe('查版本', () => {
    const catalog: NoticeCatalog = {
      esign: [
        { version: 1, title: 't', text: 'v1 文字', legalReview: 'pending' },
        { version: 2, title: 't', text: 'v2 文字', legalReview: 'approved' },
      ],
      transcript_id_pii: [{ version: 1, title: 't', text: 'x', legalReview: 'pending' }],
      certificate_pii: [{ version: 1, title: 't', text: 'x', legalReview: 'pending' }],
      case_data_sharing: [{ version: 1, title: 't', text: 'x', legalReview: 'pending' }],
    };

    it('currentNotice 回傳最高版本', () => {
      expect(currentNotice(catalog, 'esign').version).toBe(2);
    });
    it('findNotice 找得到舊版，找不到的版本回 undefined', () => {
      expect(findNotice(catalog, 'esign', 1)?.text).toBe('v1 文字');
      expect(findNotice(catalog, 'esign', 3)).toBeUndefined();
      expect(findNotice(catalog, 'esign', 0)).toBeUndefined();
    });
  });
});
