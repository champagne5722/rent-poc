// 模擬生效（MIL-98）。只在記憶體 adapter 存在，讓 demo 能從 accepted 走到 released、completed。
// 真正的生效處理是 scan-timers 的計時器，兩側各一個交易並寫分錄（ADR-0024 決議 9、11），由 MIL-107 實作後刪掉這個檔案。
// 用 node:crypto，只給 server 端用。
import { checkHandoverPreconditions } from './preconditions';
import { HANDOVER_NOT_FOUND, getOrgHandoverDetail } from './org-service';
import { applyHandoverInput, currentSnapshot, type ServiceResult } from './service';
import { hashHandoverSnapshot } from './snapshot-hash';
import type { HandoverStore } from './store';

const fail = (...errors: string[]): { ok: false; errors: string[] } => ({ ok: false, errors });

/** 模擬生效日到達、交出側交易提交：再查一次擋下條件，凍結快照並記下雜湊。 */
export async function simulateRelease(
  store: HandoverStore,
  orgId: string,
  id: string,
  now: Date,
): Promise<ServiceResult> {
  const detail = await getOrgHandoverDetail(store, orgId, id, now);
  if (!detail) return fail(HANDOVER_NOT_FOUND);
  const { record } = detail;
  if (record.state !== 'accepted') return fail('接手後、交出側生效前才能模擬交出側生效。');

  // 生效處理是擋下條件的第三個時點（ADR-0024 決議 12）。模擬時視為生效日已到，不比日期
  const reasons = checkHandoverPreconditions({
    hasActiveSigningTask: detail.hasActiveSigningTask,
    target: record.target?.kind === 'self_managed' ? { kind: 'self_managed' } : detail.receiverFacts,
    effectiveDate: null,
    today: '',
  });
  if (reasons.length > 0) return fail(...reasons.map((reason) => reason.message));

  // 凍結的是此刻從事實產生的快照，與接收方接手前看到的同一套規則
  const snapshot = currentSnapshot(record, await store.getUnitSource(record.rentalUnitId));
  const next = applyHandoverInput(
    { ...record, frozenSnapshot: snapshot, snapshotHash: hashHandoverSnapshot(snapshot) },
    'release',
    now.toISOString(),
  );
  if (!next) return fail('這個移交目前不能生效。');
  await store.saveHandover(next);
  return { ok: true, value: undefined };
}

/** 模擬接收側交易提交。 */
export async function simulateReceive(
  store: HandoverStore,
  orgId: string,
  id: string,
  now: Date,
): Promise<ServiceResult> {
  const detail = await getOrgHandoverDetail(store, orgId, id, now);
  if (!detail) return fail(HANDOVER_NOT_FOUND);
  const next = applyHandoverInput(detail.record, 'receive', now.toISOString());
  if (!next) return fail('交出側生效後才能模擬接收側完成。');
  await store.saveHandover(next);
  return { ok: true, value: undefined };
}
