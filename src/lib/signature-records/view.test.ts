import { describe, expect, it } from 'vitest';
import type { CredentialSnapshot } from './snapshot';
import type { SignatureRecordDetail } from './types';
import { signatureRecordCards } from './view';

// 合約詳情頁「簽章紀錄」區塊的資料整理（MIL-70）。純函式，不碰資料庫。

const SNAPSHOT_SEND: CredentialSnapshot = {
  decidedAt: '2026-11-09T12:00:00+08:00',
  certificateKind: 'rental_housing_manager',
  certificateNoMasked: '********200',
  validUntil: '2029-05-09',
  layers: {
    license: { state: 'verified', validUntil: null, latestCheckId: 'chk-lic' },
    practitioner: { state: 'verified', validUntil: '2029-05-09', latestCheckId: 'chk-cert' },
    employment: { state: 'verified', startsOn: '2024-11-09', endsOn: null, latestCheckId: 'chk-emp' },
  },
  result: { signable: true, renewalWindow: null },
};

function detail(overrides: Partial<SignatureRecordDetail> = {}): SignatureRecordDetail {
  return {
    id: 1,
    contractId: 1,
    signerId: 2,
    ruleId: 'lease.master_lease.practitioner',
    statuteRef: '租賃條例 §32 第 2、3 款',
    ruleVersion: 1,
    practitionerId: 'pr-chen',
    employmentId: 'emp-pr-chen',
    entityId: 'org-pe-beichen',
    licenseKind: 'master_lease',
    concurrentRoles: [],
    snapshotAtSend: SNAPSHOT_SEND,
    snapshotAtSign: null,
    createdAt: '2026-11-09 12:00:00',
    signer: { name: '陳怡君', role: 'practitioner', status: 'pending', signedAt: null },
    entityName: '北辰租賃住宅管理股份有限公司',
    ...overrides,
  };
}

const row = (card: ReturnType<typeof signatureRecordCards>[number], label: string) =>
  card.snapshotRows.find((r) => r.label === label)!;

describe('signatureRecordCards', () => {
  it('沒有紀錄時回空陣列（兩方合約不顯示）', () => {
    expect(signatureRecordCards([])).toEqual([]);
  });

  it('摘要有簽章人、執業主體、款次、規則版本、兼任角色與簽署狀態', () => {
    const [card] = signatureRecordCards([detail()]);
    expect(card.title).toBe('陳怡君');
    expect(card.summary).toEqual([
      { label: '簽章人', value: '陳怡君（租賃住宅管理人員）' },
      { label: '執業主體', value: '北辰租賃住宅管理股份有限公司' },
      { label: '依據款次', value: '租賃條例 §32 第 2、3 款' },
      { label: '規則', value: 'lease.master_lease.practitioner，版本 1' },
      { label: '兼任角色', value: '無' },
      { label: '簽署狀態', value: '尚未簽署' },
    ]);
  });

  it('兼任角色用角色名稱；已簽署顯示台灣時間', () => {
    const [card] = signatureRecordCards([
      detail({
        concurrentRoles: ['party_a'],
        signer: { name: '陳怡君', role: 'practitioner', status: 'signed', signedAt: '2026-11-10 09:30:00' },
      }),
    ]);
    expect(card.summary.find((s) => s.label === '兼任角色')?.value).toBe('甲方');
    expect(card.summary.find((s) => s.label === '簽署狀態')?.value).toBe('已簽署，2026-11-10 09:30');
  });

  it('拒簽時簽署欄寫明沒有簽署時快照', () => {
    const [card] = signatureRecordCards([
      detail({ signer: { name: '陳怡君', role: 'practitioner', status: 'declined', signedAt: null } }),
    ]);
    expect(card.summary.find((s) => s.label === '簽署狀態')?.value).toBe('已拒簽');
    expect(row(card, '判定時點').atSign).toBe('未簽署，沒有簽署時快照');
  });

  it('快照列並排送簽時與簽署時；簽署時還沒補上時，第一列寫尚未簽署，其餘留空白', () => {
    const [card] = signatureRecordCards([detail()]);
    expect(row(card, '判定時點')).toMatchObject({ atSend: '2026-11-09 12:00', atSign: '尚未簽署' });
    expect(row(card, '判定結果')).toMatchObject({ atSend: '可簽章', atSign: '—' });
    expect(row(card, '證書種類').atSend).toBe('租賃住宅管理人員');
    expect(row(card, '證書號碼').atSend).toBe('********200');
    expect(row(card, '證書效期').atSend).toBe('2029-05-09');
    expect(row(card, '業別').atSend).toBe('已驗證，核對紀錄 chk-lic');
    expect(row(card, '證書').atSend).toBe('已驗證，核對紀錄 chk-cert');
    expect(row(card, '任職').atSend).toBe('已驗證，核對紀錄 chk-emp');
    expect(row(card, '任職期間').atSend).toBe('2024-11-09 起');
  });

  it('簽署時快照顯示事件時間的判定；換證窗口內寫明期限', () => {
    const [card] = signatureRecordCards([
      detail({
        snapshotAtSign: {
          ...SNAPSHOT_SEND,
          decidedAt: '2026-11-10T01:30:00.000Z',
          result: { signable: true, renewalWindow: { validUntil: '2027-01-01', windowStartsOn: '2026-07-01' } },
        },
      }),
    ]);
    expect(row(card, '判定時點').atSign).toBe('2026-11-10 09:30');
    expect(row(card, '判定結果').atSign).toBe('可簽章，換證窗口內，證書 2027-01-01 期滿');
  });

  it('不可簽章列出全部原因', () => {
    const [card] = signatureRecordCards([
      detail({
        snapshotAtSign: {
          ...SNAPSHOT_SEND,
          result: {
            signable: false,
            issues: [
              { code: 'practitioner_expired', layer: 'practitioner', message: '證書已於 2029-05-09 期滿' },
              { code: 'employment_ended', layer: 'employment', message: '任職已結束' },
            ],
          },
        },
      }),
    ]);
    expect(row(card, '判定結果').atSign).toBe('不可簽章：證書已於 2029-05-09 期滿、任職已結束');
  });

  it('簽署事件到達時查不到登錄資料：寫明原因，其餘列留空白', () => {
    const [card] = signatureRecordCards([
      detail({ snapshotAtSign: { decidedAt: '2026-11-10T01:30:00.000Z', unavailable: true, reason: '登錄資料來源不可用' } }),
    ]);
    expect(row(card, '判定時點').atSign).toBe('2026-11-10 09:30');
    expect(row(card, '判定結果').atSign).toBe('未取得登錄資料：登錄資料來源不可用');
    expect(row(card, '證書種類').atSign).toBe('—');
  });

  it('沒有證書時顯示未登錄', () => {
    const [card] = signatureRecordCards([
      detail({
        snapshotAtSend: {
          ...SNAPSHOT_SEND,
          certificateKind: null,
          certificateNoMasked: null,
          validUntil: null,
          layers: { ...SNAPSHOT_SEND.layers, practitioner: { state: null, validUntil: null, latestCheckId: null } },
        },
      }),
    ]);
    expect(row(card, '證書種類').atSend).toBe('—');
    expect(row(card, '證書').atSend).toBe('尚未登錄');
  });

  it('查不到執業主體名稱時退回 ID', () => {
    const [card] = signatureRecordCards([detail({ entityName: null })]);
    expect(card.summary.find((s) => s.label === '執業主體')?.value).toBe('org-pe-beichen');
  });

  it('一份合約有兩位執業人員時各一張卡，依寫入順序', () => {
    const cards = signatureRecordCards([
      detail({ id: 1, ruleId: 'a' }),
      detail({ id: 2, ruleId: 'b', signer: { name: '趙經紀', role: 'practitioner', status: 'pending', signedAt: null } }),
    ]);
    expect(cards.map((c) => c.title)).toEqual(['陳怡君', '趙經紀']);
    expect(cards.map((c) => c.key)).toEqual(['a', 'b']);
  });
});
