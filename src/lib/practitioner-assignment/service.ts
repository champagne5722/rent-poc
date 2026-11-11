// 執業人員指派的服務（MIL-69）：把「指派」與「登錄資料」組成 checkSendPreconditions 的輸入，
// 並為 wizard 提供指派選項。只有這一層同時認得 practiceRegistry 與指派。
//
// 指派的來源（MIL-200）：合約掛在案件下時，指派存成案件成員（org.case_members 的席位欄）。
// 沒有案件的舊合約仍用合約上的指派表（ADR-0021 決議 4 的過渡條件，MIL-203 移除）。
// 兩種來源都由 repository 讀出同一個形狀，這裡的組裝邏輯不變。
//
// 簽章人員只從自家組織指派（ADR-0029 決議 3）：登錄查詢只回呼叫者自己組織的執業主體與人員，
// 別的組織的 ID 與不存在的 ID 回應相同。選項的回傳形狀不含 email，合約欄位要用的 email 由伺服端依所選的人補（見 route）。

import { credentialStatusAt, type RenewalWindow } from '../credential-status';
import { REQUIRED_BUSINESS_ITEM_CODE } from '../registry-rules';
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
  findMergedSeats,
  routeSignatures,
  seatSignerIndexes,
  type MergedSeats,
  type PlannedSeat,
  type PractitionerEntitySource,
  type RoutingFacts,
  type SeatAssignee,
  type SeatIdentity,
} from '../signature-routing';
import { buildCredentialSnapshot } from '../signature-records/snapshot';
import type { ContractSendRecord } from '../signature-records/types';
import { normalizeEmail } from '../signing-module/progress';
import { DEFAULT_CONTRACT_TYPE, partyOfFields, type PartyFields } from '../contract-types';
import type { ContractType } from '../labels';
import { SIGNER_ROLE_LABELS, type ContractPartyRole } from '../types';
import type { CaseSeatMember } from './repository';
import {
  licenseKindForSeat,
  partyRoleOfEntitySource,
  type PractitionerAssignmentInput,
  type PrintedPractitioner,
} from './seats';

// ── 送簽前評估 ───────────────────────────────────────────────

export interface EvaluateSendInput {
  routing: RoutingFacts;
  /** 合約類型，決定當事人取自哪些欄位。沒有帶視為租賃合約。 */
  contractType?: ContractType;
  /** 當事人姓名與 email 所在的欄位，形狀由 `contractType` 決定。 */
  fields: PartyFields;
  assignments: readonly PractitionerAssignmentInput[];
  /** 判定時點，ISO 8601。 */
  at: string;
  leasingAuthority?: LeasingAuthoritySendFacts;
}

export interface SendEvaluation extends SendPreconditionResult {
  /** 執業人員席位的簽署人，以席位 rule_id 為鍵。姓名與 email 取自登錄。 */
  assignees: Record<string, SeatAssignee>;
  printed: Record<string, PrintedPractitioner>;
  /**
   * 席位簽署人的身分，以席位 rule_id 為鍵。執業人員席位與執業主體是甲方或乙方的當事人席位才有。
   * 組簽署序列時交給 `buildSignerSequence`，合併的判定靠它（ADR-0018 決議 9）。
   */
  identities: Record<string, SeatIdentity>;
  /** 要合併成一位簽署人的席位。畫面據此提示，檢查未通過時也會列出。 */
  merges: MergedSeats[];
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

function partyField(input: EvaluateSendInput, role: ContractPartyRole) {
  return partyOfFields(input.contractType ?? DEFAULT_CONTRACT_TYPE, input.fields, role);
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
  const { routing, assignments, at } = input;
  const route = routeSignatures(routing);
  const base = { assignees: {}, printed: {}, identities: {}, merges: [], records: [] };
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

  // 席位簽署人的身分。同一人兼任的合併靠它判定，簽章紀錄的 signerIndex 也要用合併後的位置
  const identities: Record<string, SeatIdentity> = {};
  for (const r of resolved) {
    if (!r.assignment || !r.candidate) continue;
    identities[r.seat.ruleId] = { partyId: r.candidate.partyId, entityId: r.candidate.entityId };
    const partyRole = partyRoleOfEntitySource(r.seat.practitioner!.entitySource);
    const partySeat = partyRole && route.plan.seats.find((s) => s.role === partyRole);
    if (partySeat && r.partySigner) {
      identities[partySeat.ruleId] = { partyId: r.partySigner.partyId, entityId: r.partySigner.entityId };
    }
  }
  const merges = findMergedSeats(route.plan, identities);
  const signerIndexes = seatSignerIndexes(route.plan, merges);

  const extraReasons: SendBlockReason[] = [];
  const entities: Partial<Record<PractitionerEntitySource, string>> = {};
  const signers: SeatSigner[] = [];
  const assignees: Record<string, SeatAssignee> = {};
  const printed: Record<string, PrintedPractitioner> = {};
  const records: ContractSendRecord[] = [];

  for (const seat of route.plan.seats) {
    if (seat.role === 'party_a' || seat.role === 'party_b') {
      signers.push({ seatRuleId: seat.ruleId, ...partyField(input, seat.role), identity: identities[seat.ruleId] });
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
    signers.push({
      seatRuleId: seat.ruleId,
      name: r.candidate.name,
      email: r.candidate.accountEmail,
      practitioner: facts,
      identity: identities[seat.ruleId],
    });
    assignees[seat.ruleId] = { name: r.candidate.name, email: r.candidate.accountEmail };
    const print = printedOf(r);
    if (print) printed[seat.ruleId] = print;
    records.push({
      signerIndex: signerIndexes[seat.ruleId],
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
      const current = partyField(input, partyRole);
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
    identities: ok ? identities : {},
    merges,
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

/** 委託管理合約的受託人必須有代管業別（營業項目 H706011）且業別已驗證（P0-11）。 */
export const MANDATARY_LICENSE_MISSING = `缺少租賃住宅代管業的營業項目 ${REQUIRED_BUSINESS_ITEM_CODE.management}，不能擔任受託人`;
export const MANDATARY_LICENSE_UNVERIFIED = '租賃住宅代管業的業別尚未驗證，不能擔任受託人';

/** 委託管理合約的乙方（受託人）是執業主體：這個席位要查代管業別與業別是否已驗證。 */
function isMandataryEntity(routing: RoutingFacts, entitySource: PractitionerEntitySource): boolean {
  return routing.documentType === 'management' && partyRoleOfEntitySource(entitySource) === 'party_b';
}

// ── wizard 的指派選項 ────────────────────────────────────────

export interface PractitionerOption {
  id: string;
  name: string;
  title?: string;
  /** 在換證窗口內時帶期限，畫面要顯示（ADR-0017 決議 8）。 */
  renewalWindow: RenewalWindow | null;
}

export interface EntityOption {
  id: string;
  name: string;
  /**
   * 不能選的原因。委託管理合約的受託人缺少代管業別（H706011）或業別未驗證時有值，畫面標示並說明（P0-11 AC2）。
   * 其他席位只列持有業別的執業主體，沒有這個欄位。
   */
  blockedReason?: string;
  /** 執業主體不是合約的甲方或乙方時為空。 */
  partySigners: Array<Pick<PartySignerCandidate, 'id' | 'name'>>;
  practitioners: PractitionerOption[];
}

/** 經紀人席位的說明。經紀營業員不得簽章（P0-12 AC6、規則 7），選單不列出。 */
export const BROKER_ONLY_NOTICE = '這個席位只能指派不動產經紀人。不動產經紀營業員不得簽章，選單不列出。';

export interface SeatOption {
  /** 席位的 rule_id，也是指派的 slot。 */
  ruleId: string;
  label: string;
  /** 畫面在席位下方顯示的說明。 */
  notice?: string;
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
    // 委託管理合約的受託人：列出自家組織全部的執業主體，不符的標示原因，讓使用者知道為什麼不能選。
    // 登錄只回自家組織的執業主體（MIL-200），不會列出別的組織
    const isMandatary = isMandataryEntity(routing, requirement.entitySource);
    const entities = await registry.listEntities(isMandatary ? undefined : { licenseKind });
    const entityOptions = await Promise.all(
      entities.map(async (entity): Promise<EntityOption> => {
        if (isMandatary && !entity.licenseKinds.includes(licenseKind)) {
          return { id: entity.id, name: entity.name, blockedReason: MANDATARY_LICENSE_MISSING, partySigners: [], practitioners: [] };
        }
        const [partySigners, candidates] = await Promise.all([
          partyRole ? registry.listPartySigners(entity.id) : Promise.resolve([]),
          registry.listPractitioners(entity.id, {
            certificateKinds: requirement.certificateKinds,
            fullTime: requirement.fullTime,
            licenseKind,
          }),
        ]);
        const practitioners: PractitionerOption[] = [];
        let licenseUnverified = false;
        for (const c of candidates) {
          const status = credentialStatusAt(c.credential, at);
          if (!status.signable) {
            if (status.issues.some((i) => i.code === 'license_not_verified')) licenseUnverified = true;
            continue;
          }
          practitioners.push({
            id: c.id,
            name: c.name,
            ...(c.certificateKind ? { title: practitionerTitle(c.certificateKind) } : {}),
            renewalWindow: status.renewalWindow,
          });
        }
        if (isMandatary && licenseUnverified) {
          return { id: entity.id, name: entity.name, blockedReason: MANDATARY_LICENSE_UNVERIFIED, partySigners: [], practitioners: [] };
        }
        return {
          id: entity.id,
          name: entity.name,
          partySigners: partySigners.map(({ id, name }) => ({ id, name })),
          practitioners,
        };
      }),
    );
    seats.push({
      ruleId: seat.ruleId,
      label: `${SIGNER_ROLE_LABELS.practitioner}（${practitionerTitle(requirement.certificateKinds[0])}）`,
      partyRole,
      licenseKind,
      ...(requirement.entitySource === 'broker_entity' ? { notice: BROKER_ONLY_NOTICE } : {}),
      entities: entityOptions,
    });
  }
  return { available: true, registryKind: registry.kind, seats };
}

// ── 存指派時的檢查 ───────────────────────────────────────────

/**
 * 別的組織的人與不存在的人，錯誤訊息必須相同，不洩漏別的組織有沒有這個執業主體或這個人（MIL-200，ADR-0012 決議 8）。
 * 這三句只在「ID 不屬於自家組織」或「不存在」時回，所以不能再細分原因。
 */
export const NOT_OWN_ASSIGNMENT = '所選的執業主體不在自家組織內';
export const NOT_OWN_PRACTITIONER = '所選的執業人員不在這個席位的候選清單內';
export const NOT_OWN_PARTY_SIGNER = '當事人簽署人必須是所選執業主體的成員';

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
  /** 判定時點，ISO 8601。委託管理合約檢查受託人的業別層是否已驗證時用。 */
  at: string = new Date().toISOString(),
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

    // 只認自家組織的執業主體：別的組織的與不存在的是同一個回應（MIL-200，ADR-0029 決議 3）
    const entity = (await registry.listEntities()).find((e) => e.id === a.entityId);
    if (!entity) return NOT_OWN_ASSIGNMENT;
    const isMandatary = isMandataryEntity(routing, seat.practitioner.entitySource);
    if (!entity.licenseKinds.includes(licenseKind)) {
      return isMandatary ? MANDATARY_LICENSE_MISSING : '所選的執業主體沒有這個席位要求的業別';
    }

    const unchanged = stored.some(
      (s) =>
        s.slot === a.slot &&
        s.entityId === a.entityId &&
        s.practitionerId === a.practitionerId &&
        s.partySignerId === a.partySignerId,
    );
    // 經紀營業員不得簽章是法定限制，不論是否原樣再存都拒絕，並說明原因
    const salesAgent = await salesAgentIn(registry, a.practitionerId, licenseKind, seat);
    if (salesAgent) {
      return `${salesAgent.name}是${practitionerTitle('real_estate_sales_agent')}，不得簽章。經紀人席位只能指派${practitionerTitle('real_estate_broker')}。`;
    }

    if (!unchanged) {
      const candidates = await registry.listPractitioners(a.entityId, {
        certificateKinds: seat.practitioner.certificateKinds,
        fullTime: seat.practitioner.fullTime,
        licenseKind,
      });
      if (!candidates.some((c) => c.id === a.practitionerId)) return NOT_OWN_PRACTITIONER;
    }
    if (isMandatary) {
      const candidate = await registry.getPractitioner(a.practitionerId, { licenseKind });
      const status = candidate ? credentialStatusAt(candidate.credential, at) : null;
      if (status && !status.signable && status.issues.some((i) => i.code === 'license_not_verified')) {
        return MANDATARY_LICENSE_UNVERIFIED;
      }
    }

    if (a.partySignerId !== null) {
      if (!partyRoleOfEntitySource(seat.practitioner.entitySource)) return '這個席位的執業主體不是合約當事人，沒有當事人簽署人';
      const signer = await registry.getPartySigner(a.partySignerId);
      if (!signer || signer.entityId !== a.entityId) return NOT_OWN_PARTY_SIGNER;
    }
  }
  return null;
}

/** 經紀人席位指派了經紀營業員時回傳這個人，其他情況回 null。 */
async function salesAgentIn(
  registry: PracticeRegistry,
  practitionerId: string,
  licenseKind: LicenseKind,
  seat: PlannedSeat,
): Promise<PractitionerCandidate | null> {
  if (seat.practitioner?.entitySource !== 'broker_entity') return null;
  const candidate = await registry.getPractitioner(practitionerId, { licenseKind });
  return candidate?.certificateKind === 'real_estate_sales_agent' ? candidate : null;
}

export type { PrintedPractitioner, SendNotice };

// ── 存指派時要寫的資料 ───────────────────────────────────────

/** 存指派時補進合約欄位的當事人。email 是真實的，只在伺服端用，不回給瀏覽器（MIL-200）。 */
export interface PartyFill {
  role: ContractPartyRole;
  name: string;
  email: string;
}

export interface ResolvedAssignments {
  /** 案件成員的席位資料：執業人員的 party 與關係。 */
  seats: CaseSeatMember[];
  /** 當事人簽署人的姓名與真實 email，依所選的人補進合約欄位。 */
  partyFills: PartyFill[];
}

/**
 * 存指派前，依已通過 `validateAssignments` 的指派，查出要寫進案件成員與合約欄位的資料。
 * 全部用「依 ID 查單筆」讀：只有自家組織的人讀得到真實 email，別的組織的與不存在的回 null，得到同一句錯誤。
 * 同一個人在兩個席位以同一種關係出現時拒絕：案件成員同一人同一關係同時只有一列有效。
 */
export async function resolveAssignmentFacts(
  routing: RoutingFacts,
  assignments: readonly PractitionerAssignmentInput[],
  resolution: PracticeRegistryResolution,
): Promise<{ ok: true; value: ResolvedAssignments } | { ok: false; error: string }> {
  if (assignments.length === 0) return { ok: true, value: { seats: [], partyFills: [] } };
  if (!resolution.available) return { ok: false, error: resolution.reason };
  const route = routeSignatures(routing);
  if (route.kind !== 'sequence') return { ok: false, error: '這個分流條件沒有簽署序列，不能指派執業人員' };
  const { registry } = resolution;

  const seats: CaseSeatMember[] = [];
  const partyFills: PartyFill[] = [];
  const seen = new Set<string>();
  for (const a of assignments) {
    const seat = route.plan.seats.find((s) => s.ruleId === a.slot && s.practitioner);
    const licenseKind = seat && licenseKindForSeat(routing, seat);
    if (!seat?.practitioner || !licenseKind) return { ok: false, error: `目前的簽署序列沒有這個執業人員席位：${a.slot}` };
    const candidate = await registry.getPractitioner(a.practitionerId, { licenseKind });
    if (!candidate || candidate.entityId !== a.entityId) return { ok: false, error: NOT_OWN_PRACTITIONER };
    const relation = seat.practitioner.entitySource === 'broker_entity' ? 'broker' : 'practitioner';
    const key = `${relation}:${candidate.partyId}`;
    if (seen.has(key)) return { ok: false, error: '同一位人員不能同時指派到兩個席位' };
    seen.add(key);
    seats.push({ slot: a.slot, partyId: candidate.partyId, relation });

    const partyRole = partyRoleOfEntitySource(seat.practitioner.entitySource);
    if (partyRole && a.partySignerId) {
      const signer = await registry.getPartySigner(a.partySignerId);
      if (!signer || signer.entityId !== a.entityId) return { ok: false, error: NOT_OWN_PARTY_SIGNER };
      partyFills.push({ role: partyRole, name: signer.name, email: signer.email });
    }
  }
  return { ok: true, value: { seats, partyFills } };
}
