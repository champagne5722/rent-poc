import { describe, expect, it } from 'vitest';
import { CREDENTIAL_STATES, type CredentialState } from '../registry-rules';
import { credentialStatusAt, type CredentialFacts } from './credential-status';

// 查詢時點是台灣 2026-11-09 中午。ISO 字串帶 +08:00，與 UTC 的日期可能不同，測試另有跨日案例。
const AT = '2026-11-09T12:00:00+08:00';

const GOOD: CredentialFacts = {
  license: { state: 'verified', validUntil: null, latestCheckId: 'chk-license' },
  practitioner: { state: 'verified', validUntil: '2028-06-30', latestCheckId: 'chk-cert' },
  employment: { state: 'verified', startsOn: '2025-01-01', endsOn: null, latestCheckId: 'chk-emp' },
};

function with_(patch: {
  license?: Partial<CredentialFacts['license']>;
  practitioner?: Partial<CredentialFacts['practitioner']>;
  employment?: Partial<CredentialFacts['employment']>;
}): CredentialFacts {
  return {
    license: { ...GOOD.license, ...patch.license },
    practitioner: { ...GOOD.practitioner, ...patch.practitioner },
    employment: { ...GOOD.employment, ...patch.employment },
  };
}

function issuesOf(facts: CredentialFacts, at = AT) {
  const status = credentialStatusAt(facts, at);
  return status.signable ? [] : status.issues.map((i) => [i.layer, i.code]);
}

describe('credentialStatusAt：三層狀態乘查詢時點的全矩陣（ADR-0017 決議 6）', () => {
  it('三層都已驗證、都在效期內：可簽章，沒有換證窗口', () => {
    expect(credentialStatusAt(GOOD, AT)).toEqual({ signable: true, renewalWindow: null });
  });

  describe('三層狀態：只有 verified 可簽章，各層獨立判定', () => {
    const STATES: Array<CredentialState | null> = [null, ...CREDENTIAL_STATES];
    const layers = ['license', 'practitioner', 'employment'] as const;
    for (const layer of layers) {
      for (const state of STATES) {
        const expected = state === 'verified' ? [] : [[layer, `${layer}_not_verified`]];
        it(`${layer} 是 ${state ?? '無'}`, () => {
          expect(issuesOf(with_({ [layer]: { state } }))).toEqual(expected);
        });
      }
    }
  });

  it('三層都不是 verified 時三項原因全部列出，不只第一項', () => {
    const facts = with_({
      license: { state: 'lapsed' },
      practitioner: { state: 'pending' },
      employment: { state: null },
    });
    expect(issuesOf(facts)).toEqual([
      ['license', 'license_not_verified'],
      ['practitioner', 'practitioner_not_verified'],
      ['employment', 'employment_not_verified'],
    ]);
  });

  it('原因的文字說明是哪一層、什麼狀態', () => {
    const messageOf = (facts: CredentialFacts) => {
      const status = credentialStatusAt(facts, AT);
      return status.signable ? null : status.issues[0].message;
    };
    expect(messageOf(with_({ practitioner: { state: 'lapsed' } }))).toBe('證書已失效');
    expect(messageOf(with_({ employment: { state: null } }))).toBe('任職尚未登錄');
    expect(messageOf(with_({ license: { state: 'pending' } }))).toBe('業別待驗證');
  });

  describe('證書效期：查詢日不晚於 valid_until 才可簽章，期滿當天仍有效', () => {
    const rows: Array<[string, string, string[][]]> = [
      ['期滿前一天', '2026-11-10', []],
      ['期滿當天', '2026-11-09', []],
      ['期滿隔天', '2026-11-08', [['practitioner', 'practitioner_expired']]],
      ['早很久', '2020-01-01', [['practitioner', 'practitioner_expired']]],
    ];
    for (const [name, validUntil, expected] of rows) {
      it(name, () => {
        expect(issuesOf(with_({ practitioner: { validUntil } }))).toEqual(expected);
      });
    }

    it('已驗證的證書沒有登錄效期：不放行', () => {
      expect(issuesOf(with_({ practitioner: { validUntil: null } }))).toEqual([
        ['practitioner', 'practitioner_valid_until_missing'],
      ]);
    });
  });

  describe('業別效期：有登錄才比對，沒有就是不設期限', () => {
    it('業別沒有效期：可簽章', () => {
      expect(issuesOf(with_({ license: { validUntil: null } }))).toEqual([]);
    });
    it('業別效期已過：不可簽章', () => {
      expect(issuesOf(with_({ license: { validUntil: '2026-11-08' } }))).toEqual([['license', 'license_expired']]);
    });
    it('業別效期當天：可簽章', () => {
      expect(issuesOf(with_({ license: { validUntil: '2026-11-09' } }))).toEqual([]);
    });
  });

  describe('任職期間：起日當天起算，迄日當天仍有效', () => {
    const rows: Array<[string, string, string | null, string[][]]> = [
      ['起日前一天', '2026-11-10', null, [['employment', 'employment_not_started']]],
      ['起日當天', '2026-11-09', null, []],
      ['沒有迄日', '2020-01-01', null, []],
      ['迄日當天', '2020-01-01', '2026-11-09', []],
      ['迄日隔天', '2020-01-01', '2026-11-08', [['employment', 'employment_ended']]],
    ];
    for (const [name, startsOn, endsOn, expected] of rows) {
      it(name, () => {
        expect(issuesOf(with_({ employment: { startsOn, endsOn } }))).toEqual(expected);
      });
    }
  });

  describe('換證窗口：期滿前 6 個月內仍可簽章，並回傳期限（ADR-0017 決議 8）', () => {
    const rows: Array<[string, string, string | null]> = [
      ['窗口開始前一天', '2027-05-10', null],
      ['窗口開始當天', '2027-05-09', '2026-11-09'],
      ['窗口中', '2027-02-01', '2026-08-01'],
      ['期滿當天', '2026-11-09', '2026-05-09'],
    ];
    for (const [name, validUntil, windowStartsOn] of rows) {
      it(name, () => {
        expect(credentialStatusAt(with_({ practitioner: { validUntil } }), AT)).toEqual({
          signable: true,
          renewalWindow: windowStartsOn ? { validUntil, windowStartsOn } : null,
        });
      });
    }

    it('窗口長度可由設定覆蓋', () => {
      const facts = with_({ practitioner: { validUntil: '2027-05-10' } });
      expect(credentialStatusAt(facts, AT, { renewalWindowMonths: 7 })).toMatchObject({
        signable: true,
        renewalWindow: { validUntil: '2027-05-10' },
      });
    });

    it('已期滿的證書不算在窗口內，而是不可簽章', () => {
      expect(credentialStatusAt(with_({ practitioner: { validUntil: '2026-11-08' } }), AT).signable).toBe(false);
    });

    it('證書不是 verified 時不回窗口', () => {
      const status = credentialStatusAt(with_({ practitioner: { state: 'pending', validUntil: '2027-02-01' } }), AT);
      expect(status.signable).toBe(false);
    });
  });

  describe('查詢時點以台灣日期為準', () => {
    it('UTC 還是前一天，台灣已是期滿隔天：不可簽章', () => {
      const facts = with_({ practitioner: { validUntil: '2026-11-09' } });
      expect(issuesOf(facts, '2026-11-09T16:30:00Z')).toEqual([['practitioner', 'practitioner_expired']]);
    });
    it('UTC 已過午夜但台灣仍是同一天：可簽章', () => {
      const facts = with_({ practitioner: { validUntil: '2026-11-09' } });
      expect(issuesOf(facts, '2026-11-09T15:59:00Z')).toEqual([]);
    });
  });

  describe('壞資料不放行', () => {
    it('查詢時點不是有效時間', () => {
      expect(credentialStatusAt(GOOD, 'yesterday')).toEqual({
        signable: false,
        issues: [expect.objectContaining({ code: 'invalid_time' })],
      });
    });
    it('效期日期格式壞掉', () => {
      expect(issuesOf(with_({ practitioner: { validUntil: '2028/06/30' } }))).toEqual([
        ['practitioner', 'practitioner_invalid_date'],
      ]);
    });
    it('任職起日格式壞掉', () => {
      expect(issuesOf(with_({ employment: { startsOn: '' } }))).toEqual([['employment', 'employment_invalid_date']]);
    });
  });
});
