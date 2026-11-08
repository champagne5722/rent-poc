// 屋主端的移交操作（MIL-97）：發起、讀草稿、填手填欄位、確認、取消。
// 規則都在純函式（transitions、preconditions、snapshot），這裡只組合它們與 HandoverStore。
// 每個操作先檢查移交屬於這位屋主。之後 C 線的 authorize()（MIL-108）會接在這一層。
import {
  checkHandoverPreconditions,
  type HandoverTargetFacts,
  type PracticeEntityStatus,
  type ReceiverMandate,
} from './preconditions';
import { buildHandoverSnapshot, type HandoverManualFields, type HandoverSnapshot } from './snapshot';
import type {
  HandoverEventRecord,
  HandoverRecord,
  HandoverStore,
  HandoverTarget,
  MandateCase,
  PaymentAccount,
  ReceiverCandidate,
  UnitHandoverSource,
} from './store';
import {
  decideHandoverTransition,
  handoverSides,
  isCancellable,
  isOpenHandover,
  type HandoverInput,
  type HandoverSides,
} from './transitions';

export type ServiceResult<T = undefined> = { ok: true; value: T } | { ok: false; errors: string[] };

const fail = (...errors: string[]): { ok: false; errors: string[] } => ({ ok: false, errors });

/** YYYY-MM-DD，以台灣時間換日。 */
export function taipeiDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
}

const EMPTY_MANUAL: HandoverManualFields = { keyHandover: '', accessCardHandover: '', committeeContact: '' };

export interface HandoverListItem {
  record: HandoverRecord;
  sides: HandoverSides;
}

export async function listOwnerHandovers(store: HandoverStore, ownerPartyId: string): Promise<HandoverListItem[]> {
  const records = await store.listHandoversByOwner(ownerPartyId);
  return records
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((record) => ({ record, sides: handoverSides(record.state) }));
}

export interface InitiatableMandate {
  mandate: MandateCase;
  /** 委託標的清單上每個租賃單位目前進行中的移交 ID，沒有時是 null。 */
  openHandoverByUnit: Record<string, string | null>;
}

/** 發起頁可以選的委託管理案件：屋主為 `mandator`、狀態是 `active`。 */
export async function listInitiatableMandates(
  store: HandoverStore,
  ownerPartyId: string,
): Promise<InitiatableMandate[]> {
  const [mandates, handovers] = await Promise.all([
    store.listMandateCasesByOwner(ownerPartyId),
    store.listHandoversByOwner(ownerPartyId),
  ]);
  return mandates
    .filter((mandate) => mandate.status === 'active')
    .map((mandate) => ({
      mandate,
      openHandoverByUnit: Object.fromEntries(
        mandate.units.map((unit) => [
          unit.rentalUnitId,
          handovers.find((h) => h.rentalUnitId === unit.rentalUnitId && isOpenHandover(h.state))?.id ?? null,
        ]),
      ),
    }));
}

/** 逐案產生草稿。已有進行中移交的租賃單位略過。回傳新草稿的 ID。 */
export async function startHandovers(
  store: HandoverStore,
  ownerPartyId: string,
  mandateCaseId: string,
  now: Date,
): Promise<ServiceResult<string[]>> {
  const target = (await listInitiatableMandates(store, ownerPartyId)).find((m) => m.mandate.id === mandateCaseId);
  if (!target) return fail('找不到這個委託管理案件，或它已經不是委託中。');

  const at = now.toISOString();
  const created: string[] = [];
  for (const unit of target.mandate.units) {
    if (target.openHandoverByUnit[unit.rentalUnitId]) continue;
    const record: HandoverRecord = {
      id: store.newHandoverId(),
      ownerPartyId,
      mandateCaseId,
      rentalUnitId: unit.rentalUnitId,
      address: unit.address,
      unitLabel: unit.unitLabel,
      leaseCaseId: unit.leaseCaseId,
      from: { orgId: target.mandate.mandatary.orgId, name: target.mandate.mandatary.name },
      target: null,
      state: 'draft',
      effectiveDate: null,
      acknowledgedMissing: [],
      manual: EMPTY_MANUAL,
      frozenSnapshot: null,
      snapshotHash: null,
      createdAt: at,
      events: [{ type: 'handover_draft_created', at }],
    };
    await store.saveHandover(record);
    created.push(record.id);
  }
  return { ok: true, value: created };
}

export interface CandidateView {
  orgId: string;
  name: string;
  statutoryTitle: string;
  status: PracticeEntityStatus;
  mandate: ReceiverMandate;
}

export interface HandoverDetail {
  record: HandoverRecord;
  snapshot: HandoverSnapshot;
  sides: HandoverSides;
  cancellable: boolean;
  hasActiveSigningTask: boolean;
  currentAccountHolder: string | null;
  candidates: CandidateView[];
  paymentAccounts: PaymentAccount[];
}

export function mandateFor(candidate: ReceiverCandidate, rentalUnitId: string): ReceiverMandate {
  if (candidate.mandatedUnitIds.includes(rentalUnitId)) return 'valid';
  if (candidate.paperContractUnitIds.includes(rentalUnitId)) return 'paper';
  return 'none';
}

async function ownedHandover(store: HandoverStore, ownerPartyId: string, id: string) {
  const record = await store.getHandover(id);
  return record && record.ownerPartyId === ownerPartyId ? record : null;
}

export async function getHandoverDetail(
  store: HandoverStore,
  ownerPartyId: string,
  id: string,
): Promise<HandoverDetail | null> {
  const record = await ownedHandover(store, ownerPartyId, id);
  if (!record) return null;
  const [source, candidates, paymentAccounts] = await Promise.all([
    store.getUnitSource(record.rentalUnitId),
    store.listReceiverCandidates(ownerPartyId),
    store.listOwnerPaymentAccounts(ownerPartyId),
  ]);

  return {
    record,
    snapshot: currentSnapshot(record, source),
    sides: handoverSides(record.state),
    cancellable: isCancellable(record.state),
    hasActiveSigningTask: source?.hasActiveSigningTask ?? false,
    currentAccountHolder: source?.currentAccountHolder ?? null,
    candidates: candidates.map((candidate) => ({
      orgId: candidate.entity.orgId,
      name: candidate.entity.name,
      statutoryTitle: candidate.entity.statutoryTitle,
      status: candidate.entity.status,
      mandate: mandateFor(candidate, record.rentalUnitId),
    })),
    paymentAccounts,
  };
}

/** 凍結後只讀快照。凍結前從事實即時產生，來源沒有資料時六類全部列為缺項。 */
export function currentSnapshot(record: HandoverRecord, source: UnitHandoverSource | null): HandoverSnapshot {
  return (
    record.frozenSnapshot ??
    buildHandoverSnapshot({
      handoverId: record.id,
      rentalUnitId: record.rentalUnitId,
      manual: record.manual,
      ...(source?.snapshot ?? {
        hasLeaseCase: record.leaseCaseId !== null,
        title: { leaseAuthorityStatus: null, transcriptFetchedAt: null },
        people: { managementContract: null, leaseContract: null },
        condition: { moveInRecord: null, conditionAttachments: [], equipmentAttachments: [] },
        money: { depositBalance: null, prepaidRentBalance: null, unpaidPeriods: null, uncollectedRemittance: null },
        repairs: null,
      }),
    })
  );
}

export function applyHandoverInput(record: HandoverRecord, input: HandoverInput, at: string): HandoverRecord | null {
  const decision = decideHandoverTransition(record.state, input);
  if (!decision) return null;
  const event: HandoverEventRecord = { type: decision.event, at };
  return { ...record, state: decision.state, events: [...record.events, event] };
}

export async function saveManualFields(
  store: HandoverStore,
  ownerPartyId: string,
  id: string,
  manual: HandoverManualFields,
  now: Date,
): Promise<ServiceResult> {
  const record = await ownedHandover(store, ownerPartyId, id);
  if (!record) return fail('找不到這個移交。');
  if (record.state !== 'draft') return fail('只有草稿能修改手填欄位。');
  const trimmed: HandoverManualFields = {
    keyHandover: manual.keyHandover.trim(),
    accessCardHandover: manual.accessCardHandover.trim(),
    committeeContact: manual.committeeContact.trim(),
  };
  const at = now.toISOString();
  await store.saveHandover({
    ...record,
    manual: trimmed,
    events: [...record.events, { type: 'handover_manual_updated', at }],
  });
  return { ok: true, value: undefined };
}

export type ConfirmTargetInput =
  | { kind: 'mandatary'; orgId: string }
  | { kind: 'self_managed'; paymentAccountId: string; effectiveDate: string; evidenceNote: string };

export interface ConfirmHandoverInput {
  acknowledgedMissing: string[];
  target: ConfirmTargetInput;
}

/**
 * 屋主確認。交給新受託人時停在 `owner_confirmed`，等接收方接手（MIL-98）。
 * 改自管時接收方就是屋主，生效日與收款帳戶已在這一步指定，所以接著轉到 `accepted`。
 */
export async function confirmHandover(
  store: HandoverStore,
  ownerPartyId: string,
  id: string,
  input: ConfirmHandoverInput,
  now: Date,
): Promise<ServiceResult> {
  const detail = await getHandoverDetail(store, ownerPartyId, id);
  if (!detail) return fail('找不到這個移交。');
  const { record, snapshot } = detail;
  if (record.state !== 'draft') return fail('這個移交已經確認過了。');

  const errors: string[] = [];
  const acknowledged = new Set(input.acknowledgedMissing);
  const unacknowledged = snapshot.missing.filter((m) => !acknowledged.has(m.key));
  if (unacknowledged.length > 0) errors.push(`還有 ${unacknowledged.length} 個缺項沒有勾選知悉。`);

  let targetFacts: HandoverTargetFacts;
  let target: HandoverTarget;
  let effectiveDate: string | null = null;
  if (input.target.kind === 'mandatary') {
    const { orgId } = input.target;
    const candidate = detail.candidates.find((c) => c.orgId === orgId);
    if (!candidate) return fail(...errors, '請選擇新受託人。');
    targetFacts = { kind: 'mandatary', mandate: candidate.mandate, practiceEntityStatus: candidate.status };
    target = { kind: 'mandatary', orgId: candidate.orgId, name: candidate.name };
  } else {
    const { paymentAccountId, evidenceNote } = input.target;
    const account = detail.paymentAccounts.find((a) => a.id === paymentAccountId);
    if (!account) errors.push('請選擇收款帳戶。');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.target.effectiveDate)) errors.push('請指定生效日。');
    else effectiveDate = input.target.effectiveDate;
    const holderChanges =
      account !== undefined && detail.currentAccountHolder !== null && detail.currentAccountHolder !== account.holderName;
    const note = evidenceNote.trim();
    if (holderChanges && note === '') {
      errors.push(`收款帳戶持有人會從「${detail.currentAccountHolder}」改為「${account.holderName}」，請附上說明。`);
    }
    targetFacts = { kind: 'self_managed' };
    target = { kind: 'self_managed', paymentAccountId, evidenceNote: holderChanges ? note : null };
  }

  const reasons = checkHandoverPreconditions({
    hasActiveSigningTask: detail.hasActiveSigningTask,
    target: targetFacts,
    effectiveDate,
    today: taipeiDate(now),
  });
  errors.push(...reasons.map((reason) => reason.message));
  if (errors.length > 0) return fail(...errors);

  const at = now.toISOString();
  let next = applyHandoverInput(
    { ...record, target, effectiveDate, acknowledgedMissing: snapshot.missing.map((m) => m.key) },
    'owner_confirm',
    at,
  );
  if (next && target.kind === 'self_managed') next = applyHandoverInput(next, 'accept', at);
  if (!next) return fail('這個移交目前不能確認。');
  await store.saveHandover(next);
  return { ok: true, value: undefined };
}

export async function cancelHandover(
  store: HandoverStore,
  ownerPartyId: string,
  id: string,
  now: Date,
): Promise<ServiceResult> {
  const record = await ownedHandover(store, ownerPartyId, id);
  if (!record) return fail('找不到這個移交。');
  const next = applyHandoverInput(record, 'cancel', now.toISOString());
  if (!next) return fail(record.state === 'cancelled' ? '這個移交已經取消了。' : '交出側已經生效，不能取消。');
  await store.saveHandover(next);
  return { ok: true, value: undefined };
}
