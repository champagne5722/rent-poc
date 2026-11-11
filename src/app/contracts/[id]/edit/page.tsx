import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import ContractWizard from '@/components/ContractWizard';
import { loadContractWizard, type ContractWizardLoad } from '@/lib/contract-wizard-load';
import { Unauthenticated } from '@/lib/request-context';
import ForbiddenDetail from '../(detail)/ForbiddenDetail';

export const metadata: Metadata = { title: '建立合約｜租房雲端管理平台' };

// 草稿續編：建約 wizard 的第②〜④步（規格 §7）。第①步在 /contracts/new。
// 首屏資料在 server component 載入（MIL-176），ContractWizard 只管步驟與互動。
// 進來時由 resumeStepIndex 決定停在哪一步，中斷後可續作。載入中的骨架畫面在同資料夾的 loading.tsx。
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let result: ContractWizardLoad;
  try {
    result = await loadContractWizard(id);
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect(`/login?next=${encodeURIComponent(`/contracts/${id}/edit`)}`);
  }
  if (result.kind === 'not_found') notFound();
  if (result.kind === 'forbidden') return <ForbiddenDetail />;
  const { kind, ...initial } = result;
  void kind;
  return <ContractWizard initial={initial} />;
}
