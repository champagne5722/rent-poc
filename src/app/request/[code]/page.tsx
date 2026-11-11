import type { Metadata } from 'next';
import RequestLinkPage from '@/components/mandate-requests/RequestLinkPage';
import { loadLinkPage } from '@/lib/mandate-requests/page-load';

// 申請連結頁（MIL-206 畫面段）。登入前就能開，不套後台殼層（見 src/lib/auth/auth-screens.ts）。
// 資料在 server component 載入：只有業者的名稱、統編、已驗證的業別與申請的種類，不帶任何物件資料。
// 不讓搜尋引擎收錄。頁面讀 cookie 判斷登入狀態，所以每次請求都重新產生，不快取。
export const metadata: Metadata = { title: '申請連結｜租房雲端管理平台', robots: { index: false, follow: false } };

export default async function RequestLinkRoute({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const load = await loadLinkPage(code);
  return <RequestLinkPage code={code} load={load} />;
}
