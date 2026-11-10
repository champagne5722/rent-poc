import { describe, expect, it } from 'vitest';
import { CONTRACT_STATUSES, type ContractStatus } from './types';
import { contractNextStep, headerActionKeys, NEXT_STEP_ACTION_KEYS } from './contract-next-step';

const BASE = { contractType: 'lease' as const, mock: false, declinedReason: null, currentSigner: null, declinedRole: null };

describe('contractNextStep', () => {
  it('每個合約狀態都有下一步文字與負責人', () => {
    for (const status of CONTRACT_STATUSES) {
      const step = contractNextStep({ ...BASE, status });
      expect(step.headline.length, status).toBeGreaterThan(0);
      expect(step.owner.length, status).toBeGreaterThan(0);
    }
  });

  it('草稿：負責人是甲方，下一步是回建約流程完成後送簽', () => {
    const step = contractNextStep({ ...BASE, status: 'draft' });
    expect(step.owner).toBe('甲方（出租人）');
    expect(step.headline).toContain('送簽');
    expect(step.tone).toBe('neutral');
    expect(step.actionKeys).toEqual([]);
  });

  it('等乙方簽署：負責人是目前待簽的簽署人，可以撤回', () => {
    const step = contractNextStep({
      ...BASE,
      status: 'awaiting_tenant',
      currentSigner: { role: 'party_b', name: '王租客', email: 'tenant@example.com' },
    });
    expect(step.owner).toBe('乙方 王租客');
    expect(step.headline).toBe('等待乙方簽署');
    expect(step.detail).toContain('tenant@example.com');
    expect(step.tone).toBe('progress');
    expect(step.actionKeys).toEqual(['void']);
  });

  it('沒有簽署進度的舊資料：負責人退回合約狀態對應的角色，不寫姓名', () => {
    const step = contractNextStep({ ...BASE, status: 'awaiting_landlord' });
    expect(step.owner).toBe('甲方');
    expect(step.headline).toBe('等待甲方簽署');
  });

  it('等執業人員簽署：負責人角色是執業人員', () => {
    const step = contractNextStep({
      ...BASE,
      status: 'awaiting_practitioner',
      currentSigner: { role: 'practitioner', name: '陳管理', email: 'm@example.com' },
    });
    expect(step.owner).toBe('執業人員 陳管理');
    expect(step.actionKeys).toEqual(['void']);
  });

  it('已完成：下一步是下載文件，頁首放下載，下一步區塊沒有動作', () => {
    const step = contractNextStep({ ...BASE, status: 'completed' });
    expect(step.tone).toBe('success');
    expect(step.actionKeys).toEqual([]);
  });

  it('已拒簽：寫出拒簽的角色與原因，處理動作是複製為新草稿', () => {
    const step = contractNextStep({ ...BASE, status: 'declined', declinedRole: 'party_b', declinedReason: '租金太高' });
    expect(step.headline).toContain('乙方已拒簽');
    expect(step.detail).toContain('租金太高');
    expect(step.owner).toBe('甲方（出租人）');
    expect(step.tone).toBe('error');
    expect(step.actionKeys).toEqual(['copy']);
  });

  it('已拒簽但沒有原因時，不印空的原因', () => {
    const step = contractNextStep({ ...BASE, status: 'declined', declinedRole: 'party_b', declinedReason: null });
    expect(step.detail).toBeNull();
  });

  it('已撤回：處理動作是複製為新草稿', () => {
    const step = contractNextStep({ ...BASE, status: 'voided' });
    expect(step.tone).toBe('warning');
    expect(step.actionKeys).toEqual(['copy']);
  });

  it('下一步文案不暗示歷程或平台紀錄具法律效力', () => {
    for (const status of CONTRACT_STATUSES) {
      const step = contractNextStep({ ...BASE, status });
      const text = `${step.headline}${step.detail ?? ''}`;
      expect(text, status).not.toMatch(/具法律效力|法律效力|保證|擔保/);
    }
  });
});

describe('動作的擺放', () => {
  it('撤回與複製為新草稿只放在下一步區塊，頁首不重複', () => {
    const statuses: ContractStatus[] = [...CONTRACT_STATUSES];
    for (const status of statuses) {
      const header = headerActionKeys(status, { mock: false });
      for (const key of header) expect(NEXT_STEP_ACTION_KEYS as readonly string[], status).not.toContain(key);
    }
  });

  it('頁首：草稿是繼續編輯，已完成是下載文件，mock 模式沒有 Audit Trail File', () => {
    expect(headerActionKeys('draft', { mock: false })).toEqual(['edit']);
    expect(headerActionKeys('completed', { mock: false })).toEqual(['signed_pdf', 'audit_trail']);
    expect(headerActionKeys('completed', { mock: true })).toEqual(['signed_pdf']);
    expect(headerActionKeys('awaiting_tenant', { mock: false })).toEqual([]);
    expect(headerActionKeys('declined', { mock: false })).toEqual([]);
  });
});
