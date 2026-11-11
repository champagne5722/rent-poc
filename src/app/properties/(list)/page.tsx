import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import PropertyList from '@/components/PropertyList';
import { loadPropertyList, type PropertyListLoad } from '@/lib/property-list-load';
import { Unauthenticated } from '@/lib/request-context';
import ForbiddenList from './ForbiddenList';

export const metadata: Metadata = { title: '物件列表｜租房雲端管理平台' };

// 物件列表（MIL-177）。資料在 server component 載入，PropertyList 只管篩選、展開與列上操作。
// 載入中的骨架畫面在同資料夾的 loading.tsx。這頁放在 (list) 路由群組，讓骨架只套用在列表，不套用到 /properties/[id]。
export default async function PropertiesPage() {
  let result: PropertyListLoad;
  try {
    result = await loadPropertyList();
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect('/login?next=%2Fproperties');
  }
  if (result.kind === 'forbidden') return <ForbiddenList />;
  return <PropertyList groups={result.groups} vocabulary={result.vocabulary} />;
}
