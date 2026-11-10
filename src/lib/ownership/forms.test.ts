import { describe, expect, it } from 'vitest';
import { TRUST_FIELDS, parseAcquiredAt, validateCheckForm, validateTranscriptForm } from './forms';

const NOW = new Date('2026-11-10T02:00:00Z');
const base = { claimedOwner: '王大明', acquiredAt: '2026-11-09', hasTrust: false };
const trust = {
  hasTrust: true,
  trustRegisteredOwner: '王大明',
  trustRelatedParties: '受託人某某銀行',
  trustRegistrationStatus: '信託登記中',
  trustLeaseClause: '受託人得出租',
};

describe('謄本送件表單', () => {
  it('沒有信託登記：只收所有權人與取得時間', () => {
    const r = validateTranscriptForm(base, NOW);
    expect(r).toEqual({ ok: true, value: { claimedOwner: '王大明', acquiredAt: new Date('2026-11-08T16:00:00Z'), trust: null } });
  });

  it('所有權人與取得時間必填', () => {
    expect(validateTranscriptForm({ ...base, claimedOwner: '  ' }, NOW)).toMatchObject({ ok: false, field: 'claimedOwner' });
    expect(validateTranscriptForm({ ...base, acquiredAt: '' }, NOW)).toMatchObject({ ok: false, field: 'acquiredAt' });
    expect(validateTranscriptForm({ ...base, acquiredAt: 'abc' }, NOW)).toMatchObject({ ok: false, field: 'acquiredAt' });
  });

  it('取得時間不得晚於現在', () => {
    expect(validateTranscriptForm({ ...base, acquiredAt: '2026-11-11' }, NOW)).toMatchObject({ ok: false, field: 'acquiredAt' });
  });

  it('謄本顯示信託登記：四項齊全才通過', () => {
    const r = validateTranscriptForm({ ...base, ...trust }, NOW);
    expect(r).toMatchObject({ ok: true, value: { trust: { registeredOwner: '王大明', leaseClause: '受託人得出租' } } });
  });

  it.each(TRUST_FIELDS.map((f, i) => [f, ['trustRegisteredOwner', 'trustRelatedParties', 'trustRegistrationStatus', 'trustLeaseClause'][i]] as const))(
    '信託缺 %s：列出缺件',
    (field, key) => {
      const r = validateTranscriptForm({ ...base, ...trust, [key]: '' }, NOW);
      expect(r).toMatchObject({ ok: false, field: 'trust', missing: [field] });
      expect((r as { message: string }).message).toContain('必須補上');
    },
  );

  it('信託四項都缺：一次列出全部', () => {
    const r = validateTranscriptForm({ ...base, hasTrust: true }, NOW);
    expect(r).toMatchObject({ ok: false, missing: [...TRUST_FIELDS] });
  });

  it('沒勾信託時忽略信託欄位', () => {
    const r = validateTranscriptForm({ ...base, trustRegisteredOwner: '不該收' }, NOW);
    expect(r).toMatchObject({ ok: true, value: { trust: null } });
  });

  it('接受表單字串 true 與 on', () => {
    expect(validateTranscriptForm({ ...base, ...trust, hasTrust: 'true' }, NOW).ok).toBe(true);
    expect(validateTranscriptForm({ ...base, hasTrust: 'on' }, NOW)).toMatchObject({ ok: false, field: 'trust' });
  });

  it('取得時間接受完整 ISO 時間', () => {
    expect(parseAcquiredAt('2026-11-09T10:00:00+08:00')).toEqual(new Date('2026-11-09T02:00:00Z'));
    expect(parseAcquiredAt(123)).toBeNull();
  });
});

describe('審核台判定表單', () => {
  const ok = { keyMatch: true, holderMatch: false, holderMasked: '王○明', reason: '名義人與主張人不同' };

  it('接受布林值與已遮罩的名義人', () => {
    expect(validateCheckForm(ok)).toEqual({ ok: true, value: ok });
  });

  it('兩項比對必須是布林值，字串不收', () => {
    expect(validateCheckForm({ ...ok, keyMatch: 'true' })).toMatchObject({ ok: false, field: 'keyMatch' });
    expect(validateCheckForm({ ...ok, holderMatch: undefined })).toMatchObject({ ok: false, field: 'holderMatch' });
  });

  it('名義人與理由必填', () => {
    expect(validateCheckForm({ ...ok, holderMasked: ' ' })).toMatchObject({ ok: false, field: 'holderMasked' });
    expect(validateCheckForm({ ...ok, reason: '' })).toMatchObject({ ok: false, field: 'reason' });
  });

  it('名義人含身分證字號或長串數字：拒絕', () => {
    expect(validateCheckForm({ ...ok, holderMasked: 'A123456789' })).toMatchObject({ ok: false, field: 'holderMasked' });
    expect(validateCheckForm({ ...ok, holderMasked: '王大明 12345678' })).toMatchObject({ ok: false, field: 'holderMasked' });
    expect(validateCheckForm({ ...ok, holderMasked: '某某股份有限公司' }).ok).toBe(true);
  });

  it('長度上限', () => {
    expect(validateCheckForm({ ...ok, reason: 'a'.repeat(501) })).toMatchObject({ ok: false, field: 'reason' });
    expect(validateCheckForm({ ...ok, holderMasked: '字'.repeat(41) })).toMatchObject({ ok: false, field: 'holderMasked' });
  });
});
