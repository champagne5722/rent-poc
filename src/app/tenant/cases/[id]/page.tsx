import { notFound } from 'next/navigation';
import TenantCaseView from '@/components/TenantCaseView';
import { Forbidden } from '@/lib/authorize';
import { isUlid } from '@/lib/pg/ulid';
import { loadTenantCaseDetail } from '@/lib/tenant';
import { partyContextOrResponse } from '@/lib/tenant/route';

// 案件詳情（MIL-121）。別人的案件、不存在的案件、格式錯誤的編號，一律 notFound()，畫面相同（P0-09 AC1）。
//
// 給 E 線（MIL-140、MIL-123）：押金台帳、點交、報修的資料在這裡讀，再用 TenantCaseView 的 extraTabs 傳進去。
// 1. 資料：寫一個收 CaseMemberTx 的 repository 方法，查詢一律用 tx.caseId 過濾（src/lib/tenant/queries.ts 的寫法），
//    加進 loadTenantCaseDetail 的回傳，或另開 withCaseMemberTx 呼叫（動作要先加進 src/lib/access/actions/<模組>.ts）。
// 2. 畫面：做成 server 或 client 元件，包成 { key, label, children } 傳給 extraTabs。結案後所有寫入入口必須隱藏，
//    TenantCaseView 的 readOnly 已依案件狀態算好，extraTabs 的元件請自行接 readOnly（見 README）。
export default async function TenantCasePage({ params }: { params: Promise<{ id: string }> }) {
  const context = await partyContextOrResponse();
  if (!context.ok) return null;
  const { id } = await params;
  if (!isUlid(id)) notFound();
  let detail;
  try {
    detail = await loadTenantCaseDetail(context.rc, id);
  } catch (error) {
    if (error instanceof Forbidden) notFound();
    throw error;
  }
  return <TenantCaseView detail={detail} />;
}
