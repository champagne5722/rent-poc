import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import ContractDetail from '@/components/ContractDetail';
import { loadContractDetail, type ContractDetailLoad } from '@/lib/contract-detail-load';
import { Unauthenticated } from '@/lib/request-context';
import ForbiddenDetail from './ForbiddenDetail';

export const metadata: Metadata = { title: '合約詳情｜租房雲端管理平台' };

// 合約詳情（MIL-175）。資料在 server component 載入，ContractDetail 只管畫面與操作。
// 載入中的骨架畫面在同資料夾的 loading.tsx。這頁放在 (detail) 路由群組，讓骨架只套用在詳情，不套用到 /contracts/[id]/edit 的建約精靈。
export default async function ContractDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let result: ContractDetailLoad;
  try {
    result = await loadContractDetail(id);
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect(`/login?next=${encodeURIComponent(`/contracts/${id}`)}`);
  }
  if (result.kind === 'not_found') notFound();
  if (result.kind === 'forbidden') return <ForbiddenDetail />;
  const { kind, ...data } = result;
  void kind;
  return <ContractDetail {...data} />;
}
