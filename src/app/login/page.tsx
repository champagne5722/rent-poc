import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import LoginForm from '@/components/LoginForm';
import { safeNextPath } from '@/lib/auth/safe-next';
import { requestContext } from '@/lib/current-request-context';
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
  if (signedIn) redirect(next);

  return <LoginForm next={next} noIdentity={noIdentity} />;
}
