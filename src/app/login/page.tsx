import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import LoginForm from '@/components/LoginForm';
import { requestContext } from '@/lib/current-request-context';
import { Unauthenticated } from '@/lib/request-context';

export const metadata: Metadata = { title: '登入｜租房雲端管理平台' };

/** 只接受站內的相對路徑，避免登入後被導到外部網站。 */
function safeNext(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login/')) return '/';
  return value;
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = safeNext(params.next);

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
  if (signedIn) redirect(next);

  return <LoginForm next={next} noIdentity={noIdentity} />;
}
