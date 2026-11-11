import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import PropertyDetail from '@/components/PropertyDetail';
import { loadPropertyDetail, type PropertyDetailLoad } from '@/lib/property-detail-load';
import { Unauthenticated } from '@/lib/request-context';
import ForbiddenDetail from './ForbiddenDetail';

export const metadata: Metadata = { title: '物件詳情｜租房雲端管理平台' };

// 物件詳情（MIL-177）。資料在 server component 載入，PropertyDetail 只管畫面與操作。
// 載入中的骨架畫面在同資料夾的 loading.tsx。這頁放在 (detail) 路由群組，與合約詳情相同。
export default async function PropertyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let result: PropertyDetailLoad;
  try {
    result = await loadPropertyDetail(id);
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect(`/login?next=${encodeURIComponent(`/properties/${id}`)}`);
  }
  if (result.kind === 'not_found') notFound();
  if (result.kind === 'forbidden') return <ForbiddenDetail />;
  const { kind, ...data } = result;
  void kind;
  return <PropertyDetail {...data} />;
}
