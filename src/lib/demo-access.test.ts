import { describe, expect, it } from 'vitest';
import { decideDemoAccess, isPublicPath } from './demo-access';

const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString('base64')}`;

const configured = { user: 'demo', password: 'p@ss:word', onCloudRun: true };

describe('isPublicPath', () => {
  it('放行點點簽 webhook 與健康檢查', () => {
    expect(isPublicPath('/api/webhooks/dottedsign')).toBe(true);
    expect(isPublicPath('/api/health')).toBe(true);
  });

  it('其他路徑一律不放行，包含公開路徑的子路徑與前綴相同的路徑', () => {
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/api/contracts')).toBe(false);
    expect(isPublicPath('/api/mock/advance')).toBe(false);
    expect(isPublicPath('/api/webhooks/dottedsign/extra')).toBe(false);
    expect(isPublicPath('/api/healthz')).toBe(false);
  });
});

describe('decideDemoAccess', () => {
  it('公開路徑不需要帳號密碼', () => {
    expect(decideDemoAccess({ ...configured, pathname: '/api/health', authorization: null })).toBe('allow');
  });

  it('本機沒有設定密碼時不啟用 Basic Auth', () => {
    expect(
      decideDemoAccess({ pathname: '/contracts', authorization: null, user: undefined, password: undefined, onCloudRun: false })
    ).toBe('allow');
  });

  it('Cloud Run 上沒有設定密碼時拒絕存取，不得開放', () => {
    expect(
      decideDemoAccess({ pathname: '/contracts', authorization: null, user: undefined, password: undefined, onCloudRun: true })
    ).toBe('misconfigured');
    expect(
      decideDemoAccess({ pathname: '/contracts', authorization: null, user: 'demo', password: '', onCloudRun: true })
    ).toBe('misconfigured');
  });

  it('沒有帶 Authorization 時要求登入', () => {
    expect(decideDemoAccess({ ...configured, pathname: '/contracts', authorization: null })).toBe('challenge');
  });

  it('帳號密碼正確時放行，密碼能包含冒號', () => {
    expect(decideDemoAccess({ ...configured, pathname: '/contracts', authorization: basic('demo:p@ss:word') })).toBe('allow');
  });

  it('帳號或密碼錯誤時要求登入', () => {
    for (const credentials of ['demo:wrong', 'other:p@ss:word', 'demo', '', 'demo:']) {
      expect(decideDemoAccess({ ...configured, pathname: '/contracts', authorization: basic(credentials) })).toBe('challenge');
    }
  });

  it('非 Basic 配置的 Authorization 要求登入', () => {
    expect(decideDemoAccess({ ...configured, pathname: '/contracts', authorization: 'Bearer abc' })).toBe('challenge');
  });
});
