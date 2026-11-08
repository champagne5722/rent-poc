// 執業人員指派的服務（MIL-69）：把「指派」與「登錄資料」組成 checkSendPreconditions 的輸入，
// 並為 wizard 提供指派選項。只有這一層同時認得 practiceRegistry 與指派。
//
// 過渡條件（ADR-0021 決議 4）：指派存在合約上。C 線完成後，指派改由案件成員提供，
// 換掉 `assignments` 的來源即可，這裡的組裝邏輯不變。

import { credentialStatusAt, type RenewalWindow } from '../credential-status';
import { practitionerTitle, type LicenseKind } from '../labels';
import type { LeasingAuthoritySendFacts } from '../leasing-authority/preconditions';
import type {
  PartySignerCandidate,
  PracticeEntity,
  PracticeRegistry,
  PracticeRegistryResolution,
  PractitionerCandidate,
} from '../practice-registry';
import {
  checkSendPreconditions,
  type AssignedPractitionerFacts,
  type SeatSigner,
  type SendBlockReason,
  type SendNotice,
  type SendPreconditionResult,
} from '../send-preconditions';
import {
  routeSignatures,
  type PlannedSeat,
  type PractitionerEntitySource,
  type RoutingFacts,
  type SeatAssignee,
} from '../signature-routing';
import { buildCredentialSnapshot } from '../signature-records/snapshot';
import type { ContractSendRecord } from '../signature-records/types';
import { normalizeEmail } from '../signing-module/progress';
import { SIGNER_ROLE_LABELS, type ContractFields, type ContractPartyRole } from '../types';
import {
  licenseKindForSeat,
  partyRoleOfEntitySource,
  type PractitionerAssignmentInput,
  type PrintedPractitioner,
} from './seats';

// ── 送簽前評估 ───────────────────────────────────────────────

export interface EvaluateSendInput {
  routing: RoutingFacts;
  fields: Pick<ContractFields, 'landlordName' | 'landlordEmail' | 'tenantName' | 'tenantEmail'>;
  assignments: readonly PractitionerAssignmentInput[];
  /** 判定時點，ISO 8601。 */
  at: string;
  leasingAuthority?: LeasingAuthoritySendFacts;
}

export interface SendEvaluation extends SendPreconditionResult {
  /** 執業人員席位的簽署人，以席位 rule_id 為鍵。姓名與 email 取自登錄。 */
  assignees: Record<string, SeatAssignee>;
  printed: Record<string, PrintedPractitioner>;
  /** 送簽時要寫的簽章紀錄（含 snapshot_at_send），由合約訂閱者在送簽交易內寫入（MIL-70）。 */
  records: ContractSendRecord[];
}

interface ResolvedSeat {
  seat: PlannedSeat;
  assignment: PractitionerAssignmentInput | undefined;
  candidate: PractitionerCandidate | null;
  entity: PracticeEntity | null;
  partySigner: PartySignerCandidate | null;
}

function partyField(fields: EvaluateSendInput['fields'], role: ContractPartyRole) {
  return role === 'party_a'
    ? { name: fields.landlordName, email: fields.landlordEmail }
    : { name: fields.tenantName, email: fields.tenantEmail };
}

async function resolveSeat(
  routing: RoutingFacts,
  seat: PlannedSeat,
  assignments: readonly PractitionerAssignmentInput[],
  registry: PracticeRegistry,
): Promise<ResolvedSeat> {
  const assignment = assignments.find((a) => a.slot === seat.ruleId);
  const licenseKind = licenseKindForSeat(routing, seat);
  if (!assignment || !licenseKind) return { seat, assignment, candidate: null, entity: null, partySigner: null };
  const [candidate, entity, partySigner] = await Promise.all([
    registry.getPractitioner(assignment.practitionerId, { licenseKind }),
    registry.getEntity(assignment.entityId),
    assignment.partySignerId ? registry.getPartySigner(assignment.partySignerId) : Promise.resolve(null),
  ]);
  return { seat, assignment, candidate, entity, partySigner };
}

function printedOf(resolved: ResolvedSeat): PrintedPractitioner | null {
  const { candidate, entity } = resolved;
  if (!candidate || !entity) return null;
  return {
    name: candidate.name,
    entityName: entity.name,
    ...(candidate.certificateKind ? { title: practitionerTitle(candidate.certificateKind) } : {}),
  };
}

/**
 * 由合約的分流條件、欄位與指派，加上登錄資料，跑 checkSendPreconditions。
 * 回傳原因清單、換證期限，以及送簽要用的執業人員簽署人與判定事實快照。
 *
 * 當事人簽署人（執業主體是甲方或乙方時）也在這裡核對：必須選定、屬於所選的執業主體，
 * 且合約上的姓名與 email 與所選相同，這樣 PDF 上的簽署欄與實際收到簽署信的人一致（ADR-0018 決議 2）。
 */
export async function evaluateSend(
  input: EvaluateSendInput,
  resolution: PracticeRegistryResolution,
): Promise<SendEvaluation> {
  const { routing, fields, assignments, at } = input;
  const route = routeSignatures(routing);
  const base = { assignees: {}, printed: {}, records: [] };
  if (route.kind !== 'sequence') {
    return {
      ...checkSendPreconditions({ routing, at, entities: {}, signers: [], registryAvailable: resolution.available, leasingAuthority: input.leasingAuthority }),
      ...base,
    };
  }

  const practitionerSeats = route.plan.seats.filter((s) => s.practitioner);
  const resolved: ResolvedSeat[] = resolution.available
    ? await Promise.all(practitionerSeats.map((s) => resolveSeat(routing, s, assignments, resolution.registry)))
    : [];
  const resolvedBySeat = new Map(resolved.map((r) => [r.seat.ruleId, r]));

  const extraReasons: SendBlockReason[] = [];
  const entities: Partial<Record<PractitionerEntitySource, string>> = {};
  const signers: SeatSigner[] = [];
  const assignees: Record<string, SeatAssignee> = {};
  const printed: Record<string, PrintedPractitioner> = {};
  const records: ContractSendRecord[] = [];

  for (const [seatIndex, seat] of route.plan.seats.entries()) {
    if (seat.role === 'party_a' || seat.role === 'party_b') {
      signers.push({ seatRuleId: seat.ruleId, ...partyField(fields, seat.role) });
      continue;
    }
    const r = resolvedBySeat.get(seat.ruleId);
    if (!r?.assignment) continue;
    entities[seat.practitioner!.entitySource] = r.assignment.entityId;
    if (!r.candidate) {
      extraReasons.push({
        code: 'practitioner_not_found',
        message: `找不到已指派的${SIGNER_ROLE_LABELS.practitioner}，請重新指派`,
        seatRuleId: seat.ruleId,
      });
      continue;
    }
    const facts: AssignedPractitionerFacts = {
      practitionerId: r.candidate.id,
      accountEmail: r.candidate.accountEmail,
      certificateKind: r.candidate.certificateKind,
      fullTime: r.candidate.fullTime,
      isResponsiblePerson: r.candidate.isResponsiblePerson,
      employmentEntityId: r.candidate.entityId,
      credential: r.candidate.credential,
    };
    // 執業人員的 email 一律取自登錄的帳號（ADR-0018 決議 10 第 6 項）
    signers.push({ seatRuleId: seat.ruleId, name: r.candidate.name, email: r.candidate.accountEmail, practitioner: facts });
    assignees[seat.ruleId] = { name: r.candidate.name, email: r.candidate.accountEmail };
    const print = printedOf(r);
    if (print) printed[seat.ruleId] = print;
    records.push({
      signerIndex: seatIndex,
      ruleId: seat.ruleId,
      statuteRef: seat.statuteRef,
      ruleVersion: route.plan.ruleVersion,
      practitionerId: r.candidate.id,
      employmentId: r.candidate.employmentId,
      entityId: r.assignment.entityId,
      licenseKind: licenseKindForSeat(routing, seat)!,
      snapshotAtSend: buildCredentialSnapshot(r.candidate, at),
    });
  }

  // 當事人簽署人：執業主體是甲方或乙方時，簽署人必須由執業主體指派
  for (const r of resolved) {
    const partyRole = partyRoleOfEntitySource(r.seat.practitioner!.entitySource);
    if (!partyRole || !r.assignment) continue;
    const partySeat = route.plan.seats.find((s) => s.role === partyRole);
    const label = SIGNER_ROLE_LABELS[partyRole];
    const reason = (code: 'party_signer_not_assigned' | 'party_signer_mismatch', message: string) =>
      extraReasons.push({ code, message, seatRuleId: partySeat?.ruleId });
    if (!r.assignment.partySignerId) {
      reason('party_signer_not_assigned', `尚未指派${label}的當事人簽署人`);
    } else if (!r.partySigner || r.partySigner.entityId !== r.assignment.entityId) {
      reason('party_signer_mismatch', `${label}的當事人簽署人必須是所選執業主體的成員`);
    } else {
      const current = partyField(fields, partyRole);
      if (current.name !== r.partySigner.name || normalizeEmail(current.email) !== normalizeEmail(r.partySigner.email)) {
        reason('party_signer_mismatch', `${label}的姓名與 email 必須與所選的當事人簽署人相同，請重新選擇`);
      }
    }
  }

  const check = checkSendPreconditions({
    routing,
    at,
    entities,
    signers,
    registryAvailable: resolution.available,
    leasingAuthority: input.leasingAuthority,
  });
  // 查不到的人已經有專屬原因，不再重複列「尚未指派」
  const notFoundSeats = new Set(extraReasons.filter((r) => r.code === 'practitioner_not_found').map((r) => r.seatRuleId));
  const reasons = [
    ...extraReasons,
    ...check.reasons.filter((r) => !(r.code === 'practitioner_not_assigned' && notFoundSeats.has(r.seatRuleId))),
  ];
  // 檢查未通過時不交出簽署人與簽章紀錄，避免被誤用
  const ok = reasons.length === 0;
  return {
    ...check,
    ok,
    reasons: orderReasons(reasons, route.plan.seats),
    assignees: ok ? assignees : {},
    printed,
    records: ok ? records : [],
  };
}

/** 原因依席位的簽署順序排列，沒有席位的原因（email 重複、權源）排在最後。 */
function orderReasons(reasons: SendBlockReason[], seats: readonly PlannedSeat[]): SendBlockReason[] {
  const rank = (r: SendBlockReason) => {
    const index = seats.findIndex((s) => s.ruleId === r.seatRuleId);
    return index === -1 ? seats.length : index;
  };
  return reasons.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map(({ r }) => r);
}

/** 草稿預覽用：已指派而且查得到的席位印姓名、法定稱謂、執業主體，其餘留底線。不做資格檢查。 */
export async function loadPrintedPractitioners(
  routing: RoutingFacts,
  assignments: readonly PractitionerAssignmentInput[],
  resolution: PracticeRegistryResolution,
): Promise<Record<string, PrintedPractitioner>> {
  const route = routeSignatures(routing);
  if (route.kind !== 'sequence' || !resolution.available) return {};
  const seats = route.plan.seats.filter((s) => s.practitioner);
  const resolved = await Promise.all(seats.map((s) => resolveSeat(routing, s, assignments, resolution.registry)));
  const printed: Record<string, PrintedPractitioner> = {};
  for (const r of resolved) {
    const p = printedOf(r);
    if (p) printed[r.seat.ruleId] = p;
  }
  return printed;
}

// ── wizard 的指派選項 ────────────────────────────────────────

export interface PractitionerOption {
  id: string;
  name: string;
  email: string;
  title?: string;
  /** 在換證窗口內時帶期限，畫面要顯示（ADR-0017 決議 8）。 */
  renewalWindow: RenewalWindow | null;
}

export interface EntityOption {
  id: string;
  name: string;
  /** 執業主體不是合約的甲方或乙方時為空。 */
  partySigners: Array<Pick<PartySignerCandidate, 'id' | 'name' | 'email'>>;
  practitioners: PractitionerOption[];
}

export interface SeatOption {
  /** 席位的 rule_id，也是指派的 slot。 */
  ruleId: string;
  label: string;
  /** 執業主體是哪一方。null 代表不是甲乙方（經紀人席位）。 */
  partyRole: ContractPartyRole | null;
  licenseKind: LicenseKind;
  entities: EntityOption[];
}

export type SeatOptions =
  | {
      available: true;
      /** 人選的來源。seed 是示範用假資料，畫面要註明（ADR-0021 決議 3）。 */
      registryKind: 'seed' | 'live';
      seats: SeatOption[];
    }
  | { available: false; reason: string };

/**
 * 每個執業人員席位的選項：持有對應業別的執業主體、當事人簽署人候選，以及目前可簽章的執業人員。
 * 候選清單只列可簽章的人（換證窗口內算可簽章），不符的人不出現。
 */
export async function loadSeatOptions(
  routing: RoutingFacts,
  resolution: PracticeRegistryResolution,
  at: string,
): Promise<SeatOptions> {
  if (!resolution.available) return { available: false, reason: resolution.reason };
  const route = routeSignatures(routing);
  const { registry } = resolution;
  if (route.kind !== 'sequence') return { available: true, registryKind: registry.kind, seats: [] };

  const seats: SeatOption[] = [];
  for (const seat of route.plan.seats) {
    const requirement = seat.practitioner;
    const licenseKind = licenseKindForSeat(routing, seat);
    if (!requirement || !licenseKind) continue;
    const partyRole = partyRoleOfEntitySource(requirement.entitySource);
    const entities = await registry.listEntities({ licenseKind });
    const entityOptions = await Promise.all(
      entities.map(async (entity): Promise<EntityOption> => {
        const [partySigners, candidates] = await Promise.all([
          partyRole ? registry.listPartySigners(entity.id) : Promise.resolve([]),
          registry.listPractitioners(entity.id, {
            certificateKinds: requirement.certificateKinds,
            fullTime: requirement.fullTime,
            licenseKind,
          }),
        ]);
        const practitioners: PractitionerOption[] = [];
        for (const c of candidates) {
          const status = credentialStatusAt(c.credential, at);
          if (!status.signable) continue;
          practitioners.push({
            id: c.id,
            name: c.name,
            email: c.accountEmail,
            ...(c.certificateKind ? { title: practitionerTitle(c.certificateKind) } : {}),
            renewalWindow: status.renewalWindow,
          });
        }
        return {
          id: entity.id,
          name: entity.name,
          partySigners: partySigners.map(({ id, name, email }) => ({ id, name, email })),
          practitioners,
        };
      }),
    );
    seats.push({
      ruleId: seat.ruleId,
      label: `${SIGNER_ROLE_LABELS.practitioner}（${practitionerTitle(requirement.certificateKinds[0])}）`,
      partyRole,
      licenseKind,
      entities: entityOptions,
    });
  }
  return { available: true, registryKind: registry.kind, seats };
}

// ── 存指派時的檢查 ───────────────────────────────────────────

/**
 * 存草稿的指派時檢查：席位存在、執業主體持有對應業別、執業人員在該席位的候選清單內、
 * 當事人簽署人屬於所選的執業主體。通過回 null，不通過回第一條原因。
 * 資格（可簽章、換證窗口）不在這裡判定，那是送簽前檢查的事，候選清單只是讓使用者選不到明顯不符的人。
 * 與 `stored`（已存的指派）完全相同的列不重查候選清單：已存的人之後變成不符時，草稿仍要能存，
 * 使用者才換得了人，送簽前檢查會擋下不符的人。
 */
export async function validateAssignments(
  routing: RoutingFacts,
  assignments: readonly PractitionerAssignmentInput[],
  resolution: PracticeRegistryResolution,
  stored: readonly PractitionerAssignmentInput[] = [],
): Promise<string | null> {
  if (assignments.length === 0) return null;
  if (!resolution.available) return resolution.reason;
  const route = routeSignatures(routing);
  if (route.kind !== 'sequence') return '這個分流條件沒有簽署序列，不能指派執業人員';
  const { registry } = resolution;

  const seen = new Set<string>();
  for (const a of assignments) {
    if (seen.has(a.slot)) return `席位 ${a.slot} 重複指派`;
    seen.add(a.slot);
    const seat = route.plan.seats.find((s) => s.ruleId === a.slot && s.practitioner);
    const licenseKind = seat && licenseKindForSeat(routing, seat);
    if (!seat?.practitioner || !licenseKind) return `目前的簽署序列沒有這個執業人員席位：${a.slot}`;

    const entity = await registry.getEntity(a.entityId);
    if (!entity?.licenseKinds.includes(licenseKind)) return '所選的執業主體沒有這個席位要求的業別';

    const unchanged = stored.some(
      (s) =>
        s.slot === a.slot &&
        s.entityId === a.entityId &&
        s.practitionerId === a.practitionerId &&
        s.partySignerId === a.partySignerId,
    );
    if (!unchanged) {
      const candidates = await registry.listPractitioners(a.entityId, {
        certificateKinds: seat.practitioner.certificateKinds,
        fullTime: seat.practitioner.fullTime,
        licenseKind,
      });
      if (!candidates.some((c) => c.id === a.practitionerId)) return '所選的執業人員不在這個席位的候選清單內';
    }

    if (a.partySignerId !== null) {
      if (!partyRoleOfEntitySource(seat.practitioner.entitySource)) return '這個席位的執業主體不是合約當事人，沒有當事人簽署人';
      const signer = await registry.getPartySigner(a.partySignerId);
      if (!signer || signer.entityId !== a.entityId) return '當事人簽署人必須是所選執業主體的成員';
    }
  }
  return null;
}

export type { PrintedPractitioner, SendNotice };
