import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import RequestNewPage from '@/components/mandate-requests/RequestNewPage';
import NoAccess from '@/components/page/NoAccess';
import { loadCreatableKinds, type CreatableKindsLoad } from '@/lib/mandate-requests/page-load';
import { Unauthenticated } from '@/lib/request-context';

export const metadata: Metadata = { title: '產生申請連結｜租房雲端管理平台' };

// 業者產生申請連結（MIL-206 畫面段）。只有業者組織能開。已驗證的業別決定能選哪些種類，都沒有時畫面說明要先完成業別的核對。
export default async function NewRequestPage() {
  let result: CreatableKindsLoad;
  try {
    result = await loadCreatableKinds();
  } catch (error) {
    if (!(error instanceof Unauthenticated)) throw error;
    redirect('/login?next=%2Frequests%2Fnew');
  }
  if (result.kind === 'forbidden') {
    return <NoAccess title="產生申請連結" description="只有代管業者或包租業者的組織能產生申請連結。請從右上角切換身分。" />;
  }
  return <RequestNewPage creatableKinds={result.creatableKinds} />;
}
