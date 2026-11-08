// 屋主端「移交」清單（MIL-97）：進行中與已完成的移交，每列顯示兩側是否完成。
import { currentOwnerSession } from '@/lib/current-owner-session';
import { handoverStore } from '@/lib/handover/demo-store';
import { listInitiatableMandates, listOwnerHandovers } from '@/lib/handover/service';
import HandoverList, { type LapsedMandatary } from './HandoverList';

export default async function OwnerHandoversPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string }>;
}) {
  const session = await currentOwnerSession();
  // 沒有屋主身分時 OwnerShell 顯示空狀態，不渲染這裡
  if (!session) return null;

  const store = handoverStore();
  const [items, mandates, params] = await Promise.all([
    listOwnerHandovers(store, session.partyId),
    listInitiatableMandates(store, session.partyId),
    searchParams,
  ]);

  // 執業主體已失效、委託標的清單上還有單位沒有進行中移交時，提示屋主發起（P0-22 流程 1）
  const lapsed: LapsedMandatary[] = mandates
    .filter((m) => m.mandate.mandatary.status === 'lapsed')
    .map((m) => ({
      name: m.mandate.mandatary.name,
      pendingUnits: Object.values(m.openHandoverByUnit).filter((id) => id === null).length,
    }))
    .filter((m) => m.pendingUnits > 0);

  const created = Number.parseInt(params.created ?? '', 10);

  return (
    <HandoverList
      items={items}
      lapsed={lapsed}
      createdCount={Number.isNaN(created) ? null : created}
      canStart={mandates.length > 0}
    />
  );
}
