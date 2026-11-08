import { describe, expect, it } from 'vitest';
import { verifySignersEnabled } from './dottedsign';

// 是否替簽署人送 email 驗證由環境變數決定，不從金鑰推斷（MIL-65）
describe('verifySignersEnabled', () => {
  it('DOTTEDSIGN_VERIFY_SIGNERS 設為 1 時啟用', () => {
    expect(verifySignersEnabled({ DOTTEDSIGN_VERIFY_SIGNERS: '1' })).toBe(true);
  });

  it('未設定時不啟用，即使有點點簽金鑰', () => {
    expect(verifySignersEnabled({ DOTTEDSIGN_CLIENT_ID: 'id', DOTTEDSIGN_CLIENT_SECRET: 'secret' })).toBe(false);
  });

  it.each(['', '0', 'true', 'yes'])('設為 %j 時不啟用，只認 1', (value) => {
    expect(verifySignersEnabled({ DOTTEDSIGN_VERIFY_SIGNERS: value })).toBe(false);
  });
});
