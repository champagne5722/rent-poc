import { NextResponse, type NextRequest } from 'next/server';
import { decideDemoAccess } from '@/lib/demo-access';

export function proxy(request: NextRequest) {
  const access = decideDemoAccess({
    pathname: request.nextUrl.pathname,
    authorization: request.headers.get('authorization'),
    user: process.env.DEMO_BASIC_AUTH_USER,
    password: process.env.DEMO_BASIC_AUTH_PASSWORD,
    // Cloud Run 一定會注入 K_SERVICE
    onCloudRun: Boolean(process.env.K_SERVICE),
  });

  if (access === 'allow') return NextResponse.next();
  if (access === 'misconfigured') {
    console.error('[demo-access] Cloud Run 上沒有設定 DEMO_BASIC_AUTH_USER 或 DEMO_BASIC_AUTH_PASSWORD，已拒絕請求');
    return new NextResponse('demo 環境尚未設定存取密碼', { status: 503 });
  }
  return new NextResponse('需要帳號密碼', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="rent-poc demo", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
