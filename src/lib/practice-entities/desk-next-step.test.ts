import { describe, expect, it } from 'vitest';
import { deskNextStep } from './desk-next-step';

describe('deskNextStep', () => {
  const OPEN_TYPES = ['license', 'entity_claim', 'certificate', 'employment', 'consent', 'anchor_collision', 'anchor_collision_limit'];

  it.each(OPEN_TYPES)('待核對的 %s 項目有下一步與負責人', (type) => {
    const step = deskNextStep({ type, status: 'open', resolution: null });
    expect(step.headline).not.toBe('');
    expect(step.owner).toBe('平台營運者');
    expect(step.tone).toBe('progress');
  });

  it('已結案時寫出結果，不需要再處理', () => {
    const step = deskNextStep({ type: 'license', status: 'resolved', resolution: 'match' });
    expect(step.headline).toBe('已結案：相符');
    expect(step.tone).toBe('success');
    expect(step.detail).toContain('不需要再處理');
  });

  it('不符的結案結果用中性色調，不當成錯誤', () => {
    expect(deskNextStep({ type: 'certificate', status: 'resolved', resolution: 'mismatch' }).tone).toBe('neutral');
  });

  it('沒有結果的已結案項目仍有標題', () => {
    expect(deskNextStep({ type: 'license', status: 'resolved', resolution: null }).headline).toBe('已結案');
  });
});
