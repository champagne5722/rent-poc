// 後台（執業主體組織）的移交操作（MIL-98）：移交給我的案件、我交出的案件、接手、匯出移交包。
// 規則都在純函式（transitions、preconditions、package），這裡只組合它們與 HandoverStore。
// 每個操作先確認組織是這個移交的交出方或接收方。之後 C 線的 authorize()（MIL-108）會接在這一層。
// 用 node:crypto，只給 server 端用。
import { createHash } from 'node:crypto';
import { buildHandoverPackage, signedDocRefs, zipHandoverPackage } from './package';
import { checkHandoverPreconditions, type HandoverTargetFacts } from './preconditions';
import {
  applyHandoverInput,
  currentSnapshot,
  mandateFor,
  taipeiDate,
  type HandoverListItem,
  type ServiceResult,
} from './service';
import type { HandoverSnapshot } from './snapshot';
import { EVIDENCE_FILE_MAX_BYTES, EVIDENCE_FILE_TOO_LARGE, accountHolderChanges, isCalendarDate } from './holder-change';
import type { HandoverRecord, HandoverStore, HolderChangeEvidence, PaymentAccount } from './store';
import { handoverSides, type HandoverSides } from './transitions';

const fail = (...errors: string[]): { ok: false; errors: string[] } => ({ ok: false, errors });

/** 找不到，或這個組織、屋主不是交出方、接收方、屋主。route handler 依它回 404。 */
export const HANDOVER_NOT_FOUND = '找不到這個移交。';

/** 這個組織在移交裡的角色。receiver 是新受託人，releaser 是舊受託人（交出方）。 */
export type OrgHandoverRole = 'receiver' | 'releaser';

function roleOf(record: HandoverRecord, orgId: string): OrgHandoverRole | null {
  // 屋主還沒確認的草稿只有屋主看得到
  if (record.state === 'draft') return null;
  if (record.target?.kind === 'mandatary' && record.target.orgId === orgId) return 'receiver';
  if (record.from.orgId === orgId) return 'releaser';
  return null;
}

async function visibleHandover(store: HandoverStore, orgId: string, id: string) {
  const record = await store.getHandover(id);
  const role = record ? roleOf(record, orgId) : null;
  return record && role ? { record, role } : null;
}

export interface OrgHandoverLists {
  /** 移交給我的案件：這個組織是新受託人。 */
  incoming: HandoverListItem[];
  /** 我交出的案件：這個組織是舊受託人。 */
  outgoing: HandoverListItem[];
}

export async function listOrgHandovers(store: HandoverStore, orgId: string): Promise<OrgHandoverLists> {
  const records = (await store.listHandoversByOrg(orgId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lists: OrgHandoverLists = { incoming: [], outgoing: [] };
  for (const record of records) {
    const role = roleOf(record, orgId);
    if (!role) continue;
    (role === 'receiver' ? lists.incoming : lists.outgoing).push({ record, sides: handoverSides(record.state) });
  }
  return lists;
}

export interface OrgHandoverDetail {
  record: HandoverRecord;
  role: OrgHandoverRole;
  sides: HandoverSides;
  /**
   * 接收方：凍結前即時產生，凍結後是凍結的快照。
   * 交出方：只有凍結的唯讀副本（P0-22 規則 5），交出側生效前是 null。
   */
  snapshot: HandoverSnapshot | null;
  hasActiveSigningTask: boolean;
  currentAccountHolder: string | null;
  /** 接收方自己的收款帳戶。交出方是空的。 */
  paymentAccounts: PaymentAccount[];
  /** 接收方的委託與執業主體狀態，畫面即時檢查擋下條件用。 */
  receiverFacts: HandoverTargetFacts | null;
  canExport: boolean;
}

async function receiverFacts(store: HandoverStore, record: HandoverRecord): Promise<HandoverTargetFacts | null> {
  if (record.target?.kind !== 'mandatary') return null;
  const { orgId } = record.target;
  const candidate = (await store.listReceiverCandidates(record.ownerPartyId)).find((c) => c.entity.orgId === orgId);
  // 不在屋主候選清單上時視同沒有委託，也沒有已驗證的執業主體
  if (!candidate) return { kind: 'mandatary', mandate: 'none', practiceEntityStatus: 'pending' };
  return {
    kind: 'mandatary',
    mandate: mandateFor(candidate, record.rentalUnitId),
    practiceEntityStatus: candidate.entity.status,
  };
}

export async function getOrgHandoverDetail(
  store: HandoverStore,
  orgId: string,
  id: string,
): Promise<OrgHandoverDetail | null> {
  const found = await visibleHandover(store, orgId, id);
  if (!found) return null;
  const { record, role } = found;
  const isReceiver = role === 'receiver';

  const [source, paymentAccounts, facts] = await Promise.all([
    store.getUnitSource(record.rentalUnitId),
    isReceiver ? store.listOrgPaymentAccounts(orgId) : Promise.resolve([]),
    receiverFacts(store, record),
  ]);
  const hasActiveSigningTask = source?.hasActiveSigningTask ?? false;

  return {
    record,
    role,
    sides: handoverSides(record.state),
    snapshot: isReceiver ? currentSnapshot(record, source) : record.frozenSnapshot,
    hasActiveSigningTask,
    currentAccountHolder: source?.currentAccountHolder ?? null,
    paymentAccounts,
    receiverFacts: facts,
    canExport: canExport(record),
  };
}

export interface AcceptHandoverInput {
  /** YYYY-MM-DD */
  effectiveDate: string;
  paymentAccountId: string;
  evidenceNote: string;
  evidenceFile: { name: string; bytes: Uint8Array } | null;
}

/** 接收方確認接手（ADR-0024 決議 9、12）。擋下條件再跑一次，列出全部原因。 */
export async function acceptHandover(
  store: HandoverStore,
  orgId: string,
  id: string,
  input: AcceptHandoverInput,
  now: Date,
): Promise<ServiceResult> {
  const detail = await getOrgHandoverDetail(store, orgId, id);
  if (!detail || detail.role !== 'receiver') return fail(HANDOVER_NOT_FOUND);
  const { record } = detail;
  if (record.state === 'cancelled') return fail('這個移交已經取消了。');
  if (record.state !== 'owner_confirmed') return fail('這個移交已經接手了。');

  const errors: string[] = [];
  let effectiveDate: string | null = null;
  if (isCalendarDate(input.effectiveDate)) effectiveDate = input.effectiveDate;
  else errors.push('請指定生效日。');

  const account = detail.paymentAccounts.find((a) => a.id === input.paymentAccountId);
  if (!account) errors.push('請選擇收款帳戶。');

  const note = input.evidenceNote.trim();
  const file = input.evidenceFile && input.evidenceFile.bytes.length > 0 ? input.evidenceFile : null;
  if (file && file.bytes.length > EVIDENCE_FILE_MAX_BYTES) {
    errors.push(EVIDENCE_FILE_TOO_LARGE);
  }

  // TODO(MIL-105, MIL-107) evaluateHolderRule：檢查點在 accountHolderChanges，E 線提供後換成押金收取規則的判斷
  const holderChanges = accountHolderChanges(detail.currentAccountHolder, account?.holderName ?? null);
  if (holderChanges && account && note === '' && !file) {
    errors.push(`收款帳戶持有人會從「${detail.currentAccountHolder}」改為「${account.holderName}」，請附上檔案或說明。`);
  }

  const reasons = checkHandoverPreconditions({
    hasActiveSigningTask: detail.hasActiveSigningTask,
    target: detail.receiverFacts,
    effectiveDate,
    today: taipeiDate(now),
  });
  errors.push(...reasons.map((reason) => reason.message));
  if (errors.length > 0 || !account) return fail(...errors);

  const evidence: HolderChangeEvidence | null = holderChanges
    ? {
        note: note === '' ? null : note,
        file: file
          ? { name: file.name, size: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex') }
          : null,
      }
    : null;

  const next = applyHandoverInput(
    {
      ...record,
      effectiveDate,
      receiverAccount: { paymentAccountId: account.id, label: account.label, holderName: account.holderName, evidence },
    },
    'accept',
    now.toISOString(),
  );
  if (!next) return fail('這個移交目前不能接手。');
  await store.saveHandover(next);
  return { ok: true, value: undefined };
}

function canExport(record: HandoverRecord): boolean {
  return record.state === 'completed' && record.frozenSnapshot !== null && record.snapshotHash !== null;
}

/** 誰在匯出：屋主，或交出方與接收方的組織。 */
export type PackageViewer = { kind: 'owner'; partyId: string } | { kind: 'org'; orgId: string };

export interface HandoverPackageDownload {
  filename: string;
  bytes: Uint8Array;
}

/** 匯出移交包 ZIP（P0-22）。只在 `completed` 之後，屋主、交出方、接收方都能匯出。 */
export async function exportHandoverPackage(
  store: HandoverStore,
  viewer: PackageViewer,
  id: string,
): Promise<ServiceResult<HandoverPackageDownload>> {
  const record = await store.getHandover(id);
  const allowed =
    record !== null &&
    (viewer.kind === 'owner' ? record.ownerPartyId === viewer.partyId : roleOf(record, viewer.orgId) !== null);
  if (!record || !allowed) return fail(HANDOVER_NOT_FOUND);
  if (!canExport(record) || !record.frozenSnapshot || !record.snapshotHash) {
    return fail('移交完成後才能匯出移交包。');
  }

  const signedPdfs: Record<string, Uint8Array> = {};
  for (const { ref } of signedDocRefs(record.frozenSnapshot)) {
    const bytes = await store.getSignedPdf(ref.id);
    if (bytes) signedPdfs[ref.id] = bytes;
  }

  const completedAt = record.events.findLast((e) => e.type === 'handover_receive')?.at ?? record.createdAt;
  const target = record.target;
  const pkg = buildHandoverPackage({
    handover: {
      id: record.id,
      rentalUnitId: record.rentalUnitId,
      address: record.address,
      from: record.from,
      to:
        target?.kind === 'mandatary'
          ? { kind: 'mandatary', orgId: target.orgId, name: target.name }
          : { kind: 'self_managed' },
      effectiveDate: record.effectiveDate,
      completedAt,
    },
    snapshot: record.frozenSnapshot,
    snapshotHash: record.snapshotHash,
    signedPdfs,
  });
  return { ok: true, value: { filename: `handover-package-${record.id}.zip`, bytes: zipHandoverPackage(pkg) } };
}
