import { describe, expect, it } from 'vitest';
import type { SigningLapseDetail, SigningLapseState } from './types';
import { lapseAlerts } from './view';

const lapse = (state: SigningLapseState, extra: Partial<SigningLapseDetail> = {}): SigningLapseDetail => ({
  id: 1,
  contractId: 7,
  signerId: 3,
  signerName: '陳怡君',
  ruleId: 'lease.master_lease.practitioner',
  state,
  reasons: ['證書已於 2028-12-31 期滿'],
  eventAt: '2029-06-01T02:00:00.000Z',
  voidError: null,
  createdAt: '2029-06-01 10:00:00',
  updatedAt: '2029-06-01 10:00:00',
  ...extra,
});

describe('lapseAlerts：簽署中失效在詳情頁的警示', () => {
  it('沒有失效紀錄時沒有警示', () => {
    expect(lapseAlerts([], 'awaiting_landlord')).toEqual([]);
  });

  it('自動撤回失敗：合約仍在簽署中時顯示錯誤警示與撤回按鈕，附失敗原因', () => {
    const [alert, ...rest] = lapseAlerts([lapse('void_failed', { voidError: '點點簽暫時無法連線' })], 'awaiting_landlord');
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ type: 'error', canVoid: true });
    expect(alert.title).toBe('陳怡君簽署時不可簽章，自動撤回失敗');
    expect(alert.description).toContain('證書已於 2028-12-31 期滿');
    expect(alert.description).toContain('點點簽暫時無法連線');
    expect(alert.description).toContain('2029-06-01 10:00');
  });

  it('等著自動撤回：顯示警示，仍給撤回按鈕，程序中斷時使用者才有出口', () => {
    const [alert] = lapseAlerts([lapse('void_pending')], 'awaiting_practitioner');
    expect(alert).toMatchObject({ type: 'warning', canVoid: true });
    expect(alert.title).toContain('系統正在自動撤回');
  });

  it('任務已全員完成：合約維持已完成，警示沒有撤回按鈕', () => {
    const [alert] = lapseAlerts([lapse('completed_lapsed')], 'completed');
    expect(alert).toMatchObject({ type: 'warning', canVoid: false });
    expect(alert.title).toBe('陳怡君簽署時不可簽章，合約維持已完成');
    expect(alert.description).toContain('不會撤回');
  });

  it('已撤回：提示複製為新草稿並全員重簽，沒有撤回按鈕', () => {
    const [alert] = lapseAlerts([lapse('voided')], 'voided');
    expect(alert).toMatchObject({ type: 'info', canVoid: false });
    expect(alert.description).toContain('複製為新草稿');
    expect(alert.description).toContain('全員重簽');
  });

  it('合約狀態與紀錄不一致時不顯示會誤導的警示（撤回失敗但合約已不在簽署中）', () => {
    expect(lapseAlerts([lapse('void_failed')], 'declined')).toEqual([]);
    expect(lapseAlerts([lapse('task_ended')], 'declined')).toEqual([]);
    expect(lapseAlerts([lapse('voided')], 'completed')).toEqual([]);
  });

  it('多位執業人員各一則警示', () => {
    const alerts = lapseAlerts(
      [lapse('completed_lapsed', { id: 1 }), lapse('completed_lapsed', { id: 2, ruleId: 'x', signerName: '林大華' })],
      'completed',
    );
    expect(alerts.map((a) => a.key)).toEqual(['1', '2']);
    expect(alerts[1].title).toContain('林大華');
  });
});
