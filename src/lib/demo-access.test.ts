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

describe('內部 job 的路徑（ADR-0020）', () => {
  it('只放行 /api/internal/jobs/:name，名稱是小寫英數與連字號', () => {
    for (const name of ['drain-inbox', 'drain-outbox', 'scan-timers', 'anchor-audit', 'verify-audit']) {
      expect(isPublicPath(`/api/internal/jobs/${name}`)).toBe(true);
    }
  });

  it('其他內部路徑不放行', () => {
    expect(isPublicPath('/api/internal')).toBe(false);
    expect(isPublicPath('/api/internal/')).toBe(false);
    expect(isPublicPath('/api/internal/jobs')).toBe(false);
    expect(isPublicPath('/api/internal/jobs/')).toBe(false);
    expect(isPublicPath('/api/internal/other')).toBe(false);
    expect(isPublicPath('/api/internal/admin/reset')).toBe(false);
    expect(isPublicPath('/api/internal/jobs-extra/x')).toBe(false);
  });

  it('job 名稱後面不能再接路徑，也不能夾帶路徑穿越', () => {
    expect(isPublicPath('/api/internal/jobs/drain-inbox/extra')).toBe(false);
    expect(isPublicPath('/api/internal/jobs/../secret')).toBe(false);
    expect(isPublicPath('/api/internal/jobs/%2e%2e')).toBe(false);
    expect(isPublicPath('/api/internal/jobs/Drain_Inbox')).toBe(false);
    expect(isPublicPath('/api/internal/jobs/')).toBe(false);
  });

  it('job 路徑不需要帳號密碼，其他內部路徑仍要求登入', () => {
    expect(decideDemoAccess({ ...configured, pathname: '/api/internal/jobs/drain-inbox', authorization: 'Bearer token' })).toBe('allow');
    expect(decideDemoAccess({ ...configured, pathname: '/api/internal/other', authorization: 'Bearer token' })).toBe('challenge');
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
