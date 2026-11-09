import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE } from './clause-library';
import { templateReviewBlock, TEMPLATE_NOT_REVIEWED_CODE } from './template-review';

// 正式金鑰下，綁到未審閱範本的合約不得送簽（P0-10 AC5）。
// 正式環境以 DOTTEDSIGN_VERIFY_SIGNERS=1 判定，不看部署環境，也不從金鑰字串推斷（MIL-65）。

const BOUND = { templateId: 'residential-lease', templateVersion: 2 };
const PRODUCTION = { DOTTEDSIGN_VERIFY_SIGNERS: '1' };

describe('templateReviewBlock', () => {
  it('正式金鑰下，未審閱範本被擋下，原因說明範本名稱與版本', () => {
    const block = templateReviewBlock('lease', BOUND, PRODUCTION);
    expect(block).toEqual({
      code: TEMPLATE_NOT_REVIEWED_CODE,
      message: '住宅租賃契約 v2 尚未經法務審閱，正式環境無法用它送簽',
    });
  });

  it('Mock 與 sandbox（沒設 DOTTEDSIGN_VERIFY_SIGNERS）不受限', () => {
    expect(templateReviewBlock('lease', BOUND, {})).toBeNull();
    expect(templateReviewBlock('lease', BOUND, { DOTTEDSIGN_VERIFY_SIGNERS: '0' })).toBeNull();
  });

  it('部署環境不影響判定：NODE_ENV 是 production 但沒設變數，仍不受限', () => {
    expect(templateReviewBlock('lease', BOUND, { NODE_ENV: 'production' })).toBeNull();
  });

  it('金鑰字串不影響判定', () => {
    expect(templateReviewBlock('lease', BOUND, { DOTTEDSIGN_CLIENT_SECRET: 'live_xxx' })).toBeNull();
  });

  it('沒綁範本版本的早期草稿，正式金鑰下一樣擋下，原因不寫版本', () => {
    const block = templateReviewBlock('lease', {}, PRODUCTION);
    expect(block?.code).toBe(TEMPLATE_NOT_REVIEWED_CODE);
    expect(block?.message).toBe('這份合約綁定的範本版本沒有法務審閱紀錄，正式環境無法用它送簽');
  });

  it('範本已審閱就放行', () => {
    const reviewed = { lease: [{ ...DEFAULT_TEMPLATE, legalReviewed: true }], management: [] };
    expect(templateReviewBlock('lease', BOUND, PRODUCTION, reviewed)).toBeNull();
  });
});
