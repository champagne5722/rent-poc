import { describe, expect, it } from 'vitest';
import { decideSessionGate, isSessionExemptPath } from './session-gate';

describe('decideSessionGate（proxy 的樂觀檢查：只看 cookie 在不在）', () => {
  it.each(['/', '/properties', '/contracts/new', '/owner', '/owner/handovers', '/api/properties', '/api/contracts/abc', '/design'])(
    '%s 沒有 cookie 時擋下',
    (pathname) => {
      expect(decideSessionGate({ pathname, hasSessionCookie: false })).not.toBe('allow');
    },
  );

  it('頁面導向登入，API 回 401', () => {
    expect(decideSessionGate({ pathname: '/properties', hasSessionCookie: false })).toBe('redirect_login');
    expect(decideSessionGate({ pathname: '/api/properties', hasSessionCookie: false })).toBe('unauthorized');
  });

  it('有 cookie 就放行，真正的驗證在 requestContext()', () => {
    expect(decideSessionGate({ pathname: '/properties', hasSessionCookie: true })).toBe('allow');
    expect(decideSessionGate({ pathname: '/api/properties', hasSessionCookie: true })).toBe('allow');
  });

  it.each([
    '/login',
    '/api/auth/otp',
    '/api/auth/verify',
    '/api/auth/logout',
    '/demo/otp',
    '/api/health',
    '/api/webhooks/dottedsign',
  ])('%s 不需要 session', (pathname) => {
    expect(isSessionExemptPath(pathname)).toBe(true);
    expect(decideSessionGate({ pathname, hasSessionCookie: false })).toBe('allow');
  });

  it.each(['/login/extra', '/api/auth/me', '/api/auth/otp/x', '/demo', '/demo/other', '/loginx', '/api/webhooks/other'])(
    '%s 不在白名單：需要 session',
    (pathname) => {
      expect(isSessionExemptPath(pathname)).toBe(false);
    },
  );
});
