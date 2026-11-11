import { describe, expect, it } from 'vitest';
import { PROPERTY_NOT_VERIFIED_MESSAGE } from './ownership/gate';
import { AWAITING_REVIEW_MESSAGE, KEY_MISMATCH_MESSAGE } from './ownership/messages';
import { propertyNextStep, type PropertyNextStepInput } from './property-next-step';

const base: PropertyNextStepInput = {
  archived: false,
  hasKey: true,
  verificationStatus: 'pending_verification',
  nodeStatus: null,
  messages: [],
};

describe('propertyNextStep', () => {
  it('封存的物件只能查看', () => {
    const step = propertyNextStep({ ...base, archived: true });
    expect(step.headline).toBe('物件已封存，只能查看');
    expect(step.tone).toBe('neutral');
  });

  it('封存優先於核對狀態', () => {
    expect(propertyNextStep({ ...base, archived: true, verificationStatus: 'verified', nodeStatus: 'verified' }).headline).toBe('物件已封存，只能查看');
  });

  it('沒有建號時，請使用者補建號', () => {
    const step = propertyNextStep({ ...base, hasKey: false });
    expect(step.headline).toBe('補上建號，平台才能核對文件');
    expect(step.owner).toBe('你的組織');
    expect(step.tone).toBe('warning');
  });

  it('有建號但還沒送文件，請使用者上傳謄本', () => {
    expect(propertyNextStep(base).headline).toBe('上傳謄本，請平台核對文件');
    expect(propertyNextStep({ ...base, nodeStatus: 'lapsed' }).headline).toBe('上傳謄本，請平台核對文件');
  });

  it('文件已送出時，負責人是平台', () => {
    const step = propertyNextStep({ ...base, nodeStatus: 'pending_verification', messages: [AWAITING_REVIEW_MESSAGE] });
    expect(step.headline).toBe('平台核對文件中');
    expect(step.owner).toBe('平台營運者');
    expect(step.tone).toBe('progress');
  });

  it('文件不符時，請使用者修正後重送，訊息不重複', () => {
    const step = propertyNextStep({ ...base, verificationStatus: 'failed', nodeStatus: 'failed', messages: [KEY_MISMATCH_MESSAGE] });
    expect(step.headline).toBe('修正文件後，重新送出謄本');
    expect(step.detail).not.toContain(KEY_MISMATCH_MESSAGE);
    expect(step.tone).toBe('error');
  });

  it('已核對時，下一步是建立案件', () => {
    const step = propertyNextStep({ ...base, verificationStatus: 'verified', nodeStatus: 'verified' });
    expect(step.headline).toBe('物件已核對，可以建立案件');
    expect(step.tone).toBe('success');
  });

  it('還沒通過核對的每一種狀態，都說明沒有建立案件入口的原因（MIL-205）', () => {
    const states: PropertyNextStepInput[] = [
      { ...base, hasKey: false },
      base,
      { ...base, nodeStatus: 'lapsed' },
      { ...base, nodeStatus: 'pending_verification' },
      { ...base, verificationStatus: 'failed', nodeStatus: 'failed' },
    ];
    for (const input of states) {
      expect(propertyNextStep(input).detail).toContain(PROPERTY_NOT_VERIFIED_MESSAGE);
    }
  });

  it('已核對與已封存時，不提核對', () => {
    expect(propertyNextStep({ ...base, verificationStatus: 'verified', nodeStatus: 'verified' }).detail).toBeNull();
    expect(propertyNextStep({ ...base, archived: true }).detail).not.toContain(PROPERTY_NOT_VERIFIED_MESSAGE);
  });

  it('每一種核對狀態都有下一步與負責人', () => {
    for (const verificationStatus of ['pending_verification', 'verified', 'failed'] as const) {
      const step = propertyNextStep({ ...base, verificationStatus });
      expect(step.headline).not.toBe('');
      expect(step.owner).not.toBe('');
    }
  });
});
