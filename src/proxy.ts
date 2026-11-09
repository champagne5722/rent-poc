import { NextResponse, type NextRequest } from 'next/server';
import { PATH_HEADER, SESSION_COOKIE } from '@/lib/auth/config';
import { decideSessionGate } from '@/lib/auth/session-gate';
import { decideDemoAccess } from '@/lib/demo-access';

export function proxy(request: NextRequest) {
  // 第一層：demo 環境的 Basic Auth（ADR-0011），與登入並存
  const access = decideDemoAccess({
    pathname: request.nextUrl.pathname,
    authorization: request.headers.get('authorization'),
    user: process.env.DEMO_BASIC_AUTH_USER,
    password: process.env.DEMO_BASIC_AUTH_PASSWORD,
    // Cloud Run 一定會注入 K_SERVICE
    onCloudRun: Boolean(process.env.K_SERVICE),
  });

  if (access === 'misconfigured') {
    console.error('[demo-access] Cloud Run 上沒有設定 DEMO_BASIC_AUTH_USER 或 DEMO_BASIC_AUTH_PASSWORD，已拒絕請求');
    return new NextResponse('demo 環境尚未設定存取密碼', { status: 503 });
  }
  if (access === 'challenge') {
    return new NextResponse('需要帳號密碼', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="rent-poc demo", charset="UTF-8"' },
    });
  }

  // 第二層：登入（ADR-0022）。這裡只檢查 cookie 在不在，完整驗證在 requestContext()
  const gate = decideSessionGate({
    pathname: request.nextUrl.pathname,
    hasSessionCookie: Boolean(request.cookies.get(SESSION_COOKIE)?.value),
  });
  if (gate === 'unauthorized') {
    // proxy 不是 route handler，不經 jsonError（那條 ESLint 規則管的是 route）。本文形狀與 jsonError 相同
    return new NextResponse(JSON.stringify({ error: '尚未登入或沒有存取權' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (gate === 'redirect_login') {
    const login = new URL('/login', request.url);
    const next = request.nextUrl.pathname + request.nextUrl.search;
    if (next !== '/') login.searchParams.set('next', next);
    return NextResponse.redirect(login);
  }

  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
