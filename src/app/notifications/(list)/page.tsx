import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import NotificationList from '@/components/NotificationList';
import { loadNotificationList, type NotificationListLoad } from '@/lib/notifications/load';
import { Unauthenticated } from '@/lib/request-context';
import ForbiddenList from './ForbiddenList';

export const metadata: Metadata = { title: '通知列表｜租房雲端管理平台' };

// 通知清單（MIL-120、MIL-179）。資料在 server component 載入，NotificationList 只管篩選與標已讀。
// 載入中的骨架畫面在同資料夾的 loading.tsx。這頁放在 (list) 路由群組，與合約列表一致。
export default async function NotificationsPage() {
  let result: NotificationListLoad;
  try {
    result = await loadNotificationList();
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect('/login?next=%2Fnotifications');
  }
  if (result.kind === 'forbidden') return <ForbiddenList />;
  return <NotificationList items={result.items} />;
}
