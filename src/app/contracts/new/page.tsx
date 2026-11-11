import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { loadPropertyDetail, type PropertyDetailLoad } from '@/lib/property-detail-load';
import { isManagementEntry, newCaseHref, parseNewCaseParams, PROPERTY_LIST_HREF } from '@/lib/property-case-entry';
import { Unauthenticated } from '@/lib/request-context';
import NewContractWizard from './NewContractWizard';
import NewManagementContract from './NewManagementContract';

export const metadata: Metadata = { title: '建立合約｜租房雲端管理平台' };

// 建約精靈第一步（規格 §7，MIL-209）：物件與案件種類由入口帶入，精靈不再選物件。
// 入口參數：`/contracts/new?property=<物件 ID>&kind=<案件種類>`，案件種類是 lease、master_lease、sublease。
// 沒帶參數、參數不合法、物件看不到（別的組織的、不存在的、沒有權限的，對外是同一種情況）：導到物件列表。
// 例外：`?kind=management` 而且沒有 property 是委託管理合約的暫時入口（MIL-209 決定 6，給 MIL-212），保留原本的建立方式。
// 建立草稿後進 /contracts/[id]/edit 續走後三步。
export default async function NewContractPage({ searchParams }: { searchParams: Promise<{ property?: string | string[]; kind?: string | string[] }> }) {
  const raw = await searchParams;
  if (isManagementEntry(raw)) return <NewManagementContract />;
  const params = parseNewCaseParams(raw);
  if (!params) redirect(PROPERTY_LIST_HREF);

  let result: PropertyDetailLoad;
  try {
    result = await loadPropertyDetail(params.propertyId);
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect(`/login?next=${encodeURIComponent(newCaseHref(params.propertyId, params.kind))}`);
  }
  // 平台營運者的組織沒有物件，也不建案件
  if (result.kind !== 'ok' || result.orgKind === 'platform') redirect(PROPERTY_LIST_HREF);

  return <NewContractWizard property={result.property} kind={params.kind} orgKind={result.orgKind} brokerChoice={result.brokerChoice} />;
}
