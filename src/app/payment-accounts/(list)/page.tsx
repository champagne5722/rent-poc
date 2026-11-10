import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import PaymentAccountList from '@/components/PaymentAccountList';
import NoAccess from '@/components/page/NoAccess';
import { loadPaymentAccountList, type PaymentAccountListLoad } from '@/lib/payment-accounts/load';
import { Unauthenticated } from '@/lib/request-context';

export const metadata: Metadata = { title: '收款帳戶｜租房雲端管理平台' };

// 收款帳戶（MIL-118、MIL-181）。資料在 server component 載入，PaymentAccountList 只管篩選與操作。
// 載入中的骨架畫面在同資料夾的 loading.tsx。
export default async function PaymentAccountsPage() {
  let result: PaymentAccountListLoad;
  try {
    result = await loadPaymentAccountList();
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect('/login?next=%2Fpayment-accounts');
  }
  if (result.kind === 'forbidden') {
    return <NoAccess title="收款帳戶列表" description="目前的身分沒有收款帳戶。請從右上角切換到組織身分。" />;
  }
  return <PaymentAccountList items={result.items} />;
}
