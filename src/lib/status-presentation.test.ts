import { describe, expect, it } from 'vitest';
import { HANDOVER_STATES } from './handover/transitions';
import { LEASE_CASE_STATES, MANAGEMENT_CASE_STATES } from './cases/transitions';
import { QUEUE_STATUSES } from './practice-entities/queue-status';
import {
  STATUS_TONES,
  statusPresentation,
  toneTagColor,
  type StatusKind,
  type StatusValueOf,
} from './status-presentation';
import { CONTRACT_STATUSES, PROPERTY_VERIFICATION_STATUSES } from './types';

// 狀態呈現表（MIL-172）。每個狀態種類的值清單來自狀態的來源常數，
// 新增狀態值而沒有加進表時，下面的「沒有遺漏」測試會失敗（型別檢查也會失敗）。

const SOURCES: { [K in StatusKind]: readonly StatusValueOf<K>[] } = {
  contract: CONTRACT_STATUSES,
  case: [...new Set([...LEASE_CASE_STATES, ...MANAGEMENT_CASE_STATES])],
  handover: HANDOVER_STATES,
  reviewItem: QUEUE_STATUSES,
  receivablePeriod: ['unpaid', 'partial', 'paid', 'overdue', 'cancelled'],
  propertyVerification: PROPERTY_VERIFICATION_STATUSES,
};

describe('狀態呈現表：每個狀態值都有名稱與色調', () => {
  for (const kind of Object.keys(SOURCES) as StatusKind[]) {
    it.each(SOURCES[kind] as readonly string[])(`${kind}：%s`, (value) => {
      const view = statusPresentation(kind, value as never);
      expect(view.label.length).toBeGreaterThan(0);
      expect(STATUS_TONES).toContain(view.tone);
    });
  }

  it('色調只有 5 種', () => {
    expect([...STATUS_TONES]).toEqual(['neutral', 'progress', 'success', 'warning', 'error']);
  });
});

describe('狀態呈現表：名稱與色調對照（預期值取自 GLOSSARY 與重構前的畫面）', () => {
  it.each([
    ['contract', 'draft', '草稿', 'neutral'],
    ['contract', 'awaiting_tenant', '待乙方簽', 'progress'],
    ['contract', 'awaiting_landlord', '待甲方簽', 'progress'],
    ['contract', 'awaiting_practitioner', '待執業人員簽', 'progress'],
    ['contract', 'completed', '已完成', 'success'],
    ['contract', 'declined', '已拒簽', 'error'],
    ['contract', 'voided', '已撤回', 'warning'],
    ['case', 'draft', '草稿', 'neutral'],
    ['case', 'signing', '簽署中', 'progress'],
    ['case', 'active', '生效中', 'success'],
    ['case', 'move_out', '退租中', 'warning'],
    ['case', 'settling', '結算中', 'warning'],
    ['case', 'closed', '已結案', 'neutral'],
    ['case', 'aborted', '已放棄', 'neutral'],
    ['case', 'terminated', '已終止', 'warning'],
    ['case', 'expired', '已到期', 'warning'],
    ['handover', 'draft', '草稿', 'neutral'],
    ['handover', 'owner_confirmed', '等待接收方接手', 'progress'],
    ['handover', 'accepted', '等待生效', 'progress'],
    ['handover', 'released', '交出側已生效', 'warning'],
    ['handover', 'completed', '已完成', 'success'],
    ['handover', 'cancelled', '已取消', 'neutral'],
    ['reviewItem', 'open', '待核對', 'progress'],
    ['reviewItem', 'resolved', '已結案', 'neutral'],
    ['propertyVerification', 'pending_verification', '待平台核對文件', 'progress'],
    ['propertyVerification', 'verified', '已核對', 'success'],
    ['propertyVerification', 'failed', '文件不符', 'error'],
    ['receivablePeriod', 'unpaid', '未入帳', 'neutral'],
    ['receivablePeriod', 'partial', '部分入帳', 'warning'],
    ['receivablePeriod', 'paid', '已入帳', 'success'],
    ['receivablePeriod', 'overdue', '逾期', 'error'],
    ['receivablePeriod', 'cancelled', '已取消', 'neutral'],
  ] as const)('%s %s：%s、%s', (kind, value, label, tone) => {
    expect(statusPresentation(kind, value as never)).toEqual({ label, tone });
  });
});

describe('toneTagColor：色調轉成 antd Tag 的語意色', () => {
  it.each([
    ['neutral', 'default'],
    ['progress', 'processing'],
    ['success', 'success'],
    ['warning', 'warning'],
    ['error', 'error'],
  ] as const)('%s 用 %s', (tone, color) => {
    expect(toneTagColor(tone)).toBe(color);
  });
});
