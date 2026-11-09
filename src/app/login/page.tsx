import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import LoginForm from '@/components/LoginForm';
import { SESSION_COOKIE } from '@/lib/auth/config';
import { listSessionIdentities } from '@/lib/auth/login-flow';
import { safeNextPath } from '@/lib/auth/safe-next';
import { requestContext } from '@/lib/current-request-context';
import { landingPath } from '@/lib/orgs/onboarding-rules';
import { Unauthenticated } from '@/lib/request-context';

export const metadata: Metadata = { title: '登入｜租房雲端管理平台' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = safeNextPath(params.next);

  // 已經登入而且有身分的人不必再看登入頁
  let signedIn = false;
  let noIdentity = false;
  try {
    await requestContext();
    signedIn = true;
  } catch (error) {
    if (!(error instanceof Unauthenticated)) throw error;
    noIdentity = error.reason === 'no_identity';
  }
  if (signedIn) {
    // 沒有明確的 ?next= 時，依身分落地（MIL-106）
    if (next !== '/') redirect(next);
    const list = await listSessionIdentities((await cookies()).get(SESSION_COOKIE)?.value, new Date());
    redirect(list ? landingPath(list.options) : '/');
  }

  return <LoginForm next={next} noIdentity={noIdentity} />;
}
