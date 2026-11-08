import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_LAYERS,
  CREDENTIAL_STATES,
  decideCredentialTransition,
  type CredentialEvent,
  type CredentialEventType,
  type CredentialLayer,
  type CredentialState,
} from './credential-transition';

// 每種事件的合法樣本（條件都成立）。
const EVENTS: Record<CredentialEventType, CredentialEvent> = {
  submitted: { type: 'submitted', requiredFieldsComplete: true },
  check_matched: { type: 'check_matched', violatesExclusivity: false },
  check_mismatched: { type: 'check_mismatched' },
  resubmitted: { type: 'resubmitted' },
  renewed: { type: 'renewed', newValidUntil: '2031-01-15' },
  expired: { type: 'expired', queryDate: '2026-11-09', validUntil: '2026-11-08' },
  revoked: { type: 'revoked' },
  registration_lost: { type: 'registration_lost' },
  employment_ended: { type: 'employment_ended' },
  consent_ended: { type: 'consent_ended' },
};

// ADR-0017 決議 4 的轉移表，逐列照抄。沒列出的（狀態、事件）組合一律不接受。
const TABLE: Array<[CredentialState | null, CredentialEventType, CredentialState]> = [
  [null, 'submitted', 'pending'],
  ['pending', 'check_matched', 'verified'],
  ['pending', 'check_mismatched', 'pending'],
  ['pending', 'resubmitted', 'pending'],
  ['verified', 'renewed', 'verified'],
  ['verified', 'expired', 'lapsed'],
  ['verified', 'revoked', 'lapsed'],
  ['verified', 'registration_lost', 'lapsed'],
  ['verified', 'employment_ended', 'lapsed'],
  ['verified', 'consent_ended', 'lapsed'],
  ['lapsed', 'resubmitted', 'pending'],
];

// 事件適用的層。其餘事件（submitted、核對、revoked）三層共用。
const ALL: readonly CredentialLayer[] = ['license', 'practitioner', 'employment'];
const LAYERS_OF: Record<CredentialEventType, readonly CredentialLayer[]> = {
  submitted: ALL,
  check_matched: ALL,
  check_mismatched: ALL,
  resubmitted: ALL,
  renewed: ['license', 'practitioner'],
  expired: ['license', 'practitioner'],
  revoked: ALL,
  registration_lost: ['license'],
  employment_ended: ['employment'],
  consent_ended: ['employment'],
};

const STATES: Array<CredentialState | null> = [null, ...CREDENTIAL_STATES];

describe('decideCredentialTransition 全矩陣', () => {
  for (const layer of CREDENTIAL_LAYERS) {
    describe(`層：${layer}`, () => {
      for (const state of STATES) {
        for (const type of Object.keys(EVENTS) as CredentialEventType[]) {
          const row = TABLE.find(([s, e]) => s === state && e === type);
          // 新任職建新列：已結束的任職不回到 pending（ADR-0017 決議 4）
          const lapsedEmploymentResubmit = layer === 'employment' && state === 'lapsed' && type === 'resubmitted';
          const accepted = row !== undefined && LAYERS_OF[type].includes(layer) && !lapsedEmploymentResubmit;

          it(`${state ?? '無'} + ${type} -> ${accepted ? row![2] : '不接受'}`, () => {
            const result = decideCredentialTransition(state, { layer, event: EVENTS[type] });
            if (!accepted) {
              expect(result).toBeNull();
              return;
            }
            expect(result).toMatchObject({ from: state, to: row![2], event: type });
          });
        }
      }
    });
  }
});

describe('decideCredentialTransition 條件', () => {
  const t = (state: CredentialState | null, event: CredentialEvent, layer: CredentialLayer = 'practitioner') =>
    decideCredentialTransition(state, { layer, event });

  it('必填欄位不齊全時 submitted 不接受', () => {
    expect(t(null, { type: 'submitted', requiredFieldsComplete: false })).toBeNull();
  });

  it('核對相符但違反專任排除約束時不接受', () => {
    expect(t('pending', { type: 'check_matched', violatesExclusivity: true })).toBeNull();
  });

  it('renewed 帶出新的 valid_until', () => {
    expect(t('verified', { type: 'renewed', newValidUntil: '2031-01-15' })).toEqual({
      from: 'verified',
      to: 'verified',
      event: 'renewed',
      validUntil: '2031-01-15',
    });
  });

  it('renewed 的新效期不是有效日期時不接受', () => {
    expect(t('verified', { type: 'renewed', newValidUntil: '2031-02-30' })).toBeNull();
  });

  it.each([
    ['查詢日晚於 valid_until', '2026-11-09', '2026-11-08', 'lapsed'],
    ['查詢日等於 valid_until（當天仍有效）', '2026-11-08', '2026-11-08', null],
    ['查詢日早於 valid_until', '2026-11-07', '2026-11-08', null],
    ['沒有 valid_until', '2026-11-09', null, null],
    ['查詢日格式錯誤', '2026/11/09', '2026-11-08', null],
  ] as const)('expired：%s', (_name, queryDate, validUntil, expectedTo) => {
    const result = t('verified', { type: 'expired', queryDate, validUntil });
    expect(result?.to ?? null).toBe(expectedTo);
  });

  it('不接受時不改變輸入', () => {
    const event: CredentialEvent = { type: 'revoked' };
    const input = { layer: 'practitioner' as const, event };
    decideCredentialTransition('pending', input);
    expect(input).toEqual({ layer: 'practitioner', event: { type: 'revoked' } });
  });

  it('只有 renewed 帶 validUntil', () => {
    expect(t('pending', { type: 'check_matched', violatesExclusivity: false })).not.toHaveProperty('validUntil');
  });
});
