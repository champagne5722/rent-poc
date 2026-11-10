import { describe, expect, it } from 'vitest';
import { handoverNextStep } from './next-step';
import { HANDOVER_STATES } from './transitions';

describe('handoverNextStep', () => {
  it('每個移交狀態與每種身分都有下一步文字與負責人', () => {
    for (const state of HANDOVER_STATES) {
      for (const viewer of ['owner', 'receiver', 'releaser'] as const) {
        const step = handoverNextStep(state, viewer, '2026-12-01');
        expect(step.headline.length, `${state}/${viewer}`).toBeGreaterThan(0);
        expect(step.owner.length, `${state}/${viewer}`).toBeGreaterThan(0);
      }
    }
  });

  it('草稿由屋主處理', () => {
    const step = handoverNextStep('draft', 'owner', null);
    expect(step.owner).toBe('屋主');
    expect(step.headline).toContain('確認移交');
  });

  it('等待接收方接手：負責人是接收方，只有屋主看到能取消的提示', () => {
    expect(handoverNextStep('owner_confirmed', 'owner', null).owner).toBe('接收方');
    expect(handoverNextStep('owner_confirmed', 'owner', null).detail).toContain('取消');
    expect(handoverNextStep('owner_confirmed', 'receiver', null).detail).toBeNull();
  });

  it('等待生效：標題帶生效日', () => {
    expect(handoverNextStep('accepted', 'owner', '2026-12-01').headline).toContain('2026-12-01');
  });

  it('交出側已生效：色調是警告，說明不能取消', () => {
    const step = handoverNextStep('released', 'owner', null);
    expect(step.tone).toBe('warning');
    expect(step.detail).toContain('不能取消');
  });
});
