import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import ContractList from '@/components/ContractList';
import { loadContractList, type ContractListLoad } from '@/lib/contract-list-load';
import { Unauthenticated } from '@/lib/request-context';
import ForbiddenList from './ForbiddenList';

export const metadata: Metadata = { title: '合約列表｜租房雲端管理平台' };

// 合約列表（MIL-174）。資料在 server component 載入，ContractList 只管篩選與列上操作。
// 載入中的骨架畫面在同資料夾的 loading.tsx。這頁放在 (list) 路由群組，讓骨架只套用在列表，不套用到 /contracts/[id] 與 /contracts/new。
export default async function ContractsPage() {
  let result: ContractListLoad;
  try {
    result = await loadContractList();
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect('/login?next=%2Fcontracts');
  }
  if (result.kind === 'forbidden') return <ForbiddenList />;
  return <ContractList contracts={result.contracts} progress={result.progress} displayCodes={result.displayCodes} />;
}
