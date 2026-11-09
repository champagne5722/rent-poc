import { describe, expect, it } from 'vitest';
import { anchorProvidersFromEnv } from './providers-from-env';

// 由環境變數決定用哪個錨定服務（MIL-88）。正式環境不設定就拒絕，不退回 Mock：
// Mock 的回執沒有簽章，退回它會讓稽核鏈看起來有錨定，其實沒有。

const now = () => new Date('2026-11-10T03:00:00Z');

describe('anchorProvidersFromEnv', () => {
  it('AUDIT_ANCHOR_PROVIDER=freetsa：主錨與驗證登錄表都是 freetsa', () => {
    const { primary, byId } = anchorProvidersFromEnv({ AUDIT_ANCHOR_PROVIDER: 'freetsa', NODE_ENV: 'production' }, now);
    expect(primary.id).toBe('freetsa');
    expect(Object.keys(byId)).toEqual(['freetsa']);
  });

  it('AUDIT_ANCHOR_PROVIDER=mock：非正式環境可用', () => {
    const { primary, byId } = anchorProvidersFromEnv({ AUDIT_ANCHOR_PROVIDER: 'mock', NODE_ENV: 'development' }, now);
    expect(primary.id).toBe('mock');
    expect(Object.keys(byId).sort()).toEqual(['freetsa', 'mock']);
  });

  it('沒設定：非正式環境預設 mock', () => {
    expect(anchorProvidersFromEnv({ NODE_ENV: 'development' }, now).primary.id).toBe('mock');
    expect(anchorProvidersFromEnv({}, now).primary.id).toBe('mock');
  });

  it('沒設定：正式環境丟錯', () => {
    expect(() => anchorProvidersFromEnv({ NODE_ENV: 'production' }, now)).toThrow(/AUDIT_ANCHOR_PROVIDER/);
    expect(() => anchorProvidersFromEnv({ NODE_ENV: 'production', AUDIT_ANCHOR_PROVIDER: '  ' }, now)).toThrow(/AUDIT_ANCHOR_PROVIDER/);
  });

  it('正式環境不得用 mock', () => {
    expect(() => anchorProvidersFromEnv({ NODE_ENV: 'production', AUDIT_ANCHOR_PROVIDER: 'mock' }, now)).toThrow(/正式環境/);
  });

  it('不認得的名稱丟錯', () => {
    expect(() => anchorProvidersFromEnv({ AUDIT_ANCHOR_PROVIDER: 'twca' }, now)).toThrow(/twca/);
  });
});
