import { describe, expect, it } from 'vitest';
import { HANDOVER_STATES } from './handover/transitions';
import { STATUTORY_CASE_KINDS } from './cases/case-kind';
import { LEASE_CASE_STATES, MANAGEMENT_CASE_STATES } from './cases/transitions';
import { DOCUMENT_CHECK_RESULTS, OWNERSHIP_ITEM_STATUSES } from './ownership/review-status';
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
  caseKind: STATUTORY_CASE_KINDS,
  handover: HANDOVER_STATES,
  reviewItem: QUEUE_STATUSES,
  receivablePeriod: ['unpaid', 'partial', 'paid', 'overdue', 'cancelled'],
  propertyVerification: PROPERTY_VERIFICATION_STATUSES,
  ownershipItem: OWNERSHIP_ITEM_STATUSES,
  documentCheck: DOCUMENT_CHECK_RESULTS,
  paymentAccount: ['active', 'inactive'],
  licensePhase: ['not_submitted', 'awaiting_review', 'needs_resubmission', 'verified', 'lapsed'],
  practitionerPhase: ['not_submitted', 'awaiting_review', 'needs_resubmission', 'verified', 'lapsed', 'ended'],
  credentialState: ['pending', 'verified', 'lapsed'],
  leaseState: ['vacant', 'draft', 'signing', 'active', 'move_out', 'settling'],
  leaseAuthority: ['verified', 'pending', 'failed', 'expired'],
  mandateRequest: ['pending_owner', 'pending_practice', 'accepted', 'declined', 'withdrawn', 'ended', 'completed', 'expired'],
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
    // 案件種類（MIL-195，ADR-0030 決議 1）：名稱取自 GLOSSARY，包租案件指屋主租給包租業者，轉租案件指包租業者轉租給承租人
    ['caseKind', 'lease', '租賃案件', 'neutral'],
    ['caseKind', 'management', '委託管理案件', 'neutral'],
    ['caseKind', 'master_lease', '包租案件', 'neutral'],
    ['caseKind', 'sublease', '轉租案件', 'neutral'],
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
    ['ownershipItem', 'pending', '待核對', 'progress'],
    ['ownershipItem', 'overdue', '超過 1 個工作日', 'warning'],
    ['ownershipItem', 'held', '待處理', 'warning'],
    ['ownershipItem', 'verified', '已通過', 'success'],
    ['ownershipItem', 'failed', '不符', 'error'],
    ['ownershipItem', 'superseded', '已被取代', 'neutral'],
    ['documentCheck', 'pending', '待判定', 'neutral'],
    ['documentCheck', 'match', '相符', 'success'],
    ['documentCheck', 'mismatch', '不符', 'error'],
    // 執業主體與執業人員（MIL-181）：「尚未送件」兩端同名，驗證狀態與進度的「已驗證」同色
    ['paymentAccount', 'active', '使用中', 'success'],
    ['paymentAccount', 'inactive', '已停用', 'neutral'],
    ['licensePhase', 'not_submitted', '尚未送件', 'neutral'],
    ['licensePhase', 'awaiting_review', '待核對', 'progress'],
    ['licensePhase', 'needs_resubmission', '待補件', 'warning'],
    ['licensePhase', 'verified', '已驗證', 'success'],
    ['licensePhase', 'lapsed', '已失效', 'error'],
    ['practitionerPhase', 'not_submitted', '尚未送件', 'neutral'],
    ['practitionerPhase', 'ended', '已失效', 'error'],
    ['credentialState', 'pending', '待驗證', 'neutral'],
    ['credentialState', 'verified', '已驗證', 'success'],
    ['credentialState', 'lapsed', '已失效', 'error'],
    ['receivablePeriod', 'unpaid', '未入帳', 'neutral'],
    ['receivablePeriod', 'partial', '部分入帳', 'warning'],
    ['receivablePeriod', 'paid', '已入帳', 'success'],
    ['receivablePeriod', 'overdue', '逾期', 'error'],
    ['receivablePeriod', 'cancelled', '已取消', 'neutral'],
    ['leaseState', 'active', '出租中', 'success'],
    ['leaseState', 'signing', '簽約中', 'progress'],
    ['leaseAuthority', 'pending', '待驗證', 'warning'],
    ['leaseAuthority', 'expired', '已失效', 'error'],
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
