// 簽署進度的步驟與目前位置（MIL-72）。
// 純函式，沒有 I/O，不依賴 React 與資料庫，client、server 與 F 線的資產總覽（MIL-102）都能直接呼叫。
// 步驟一律用簽署人畫，不用席位：同一人兼任合併後，簽署人數可能少於席位數（MIL-76）。

import { partyLabels, type ContractType } from './labels';
import type { SignerRecord, SigningProgress } from './signing-module/sign-task-store';
import type { ContractStatus, SignerRole } from './types';
import { SIGNER_ROLE_LABELS, isSigningStatus } from './types';

/** 簽署序列中的一個席位。簽章分流的 `SeatView` 符合這個形狀。 */
export interface SigningSeat {
  /** 規則列的 rule_id。算兼任合併時才需要。 */
  ruleId?: string;
  role: SignerRole;
  /** 簡稱：乙方、執業人員（租賃住宅管理人員）。 */
  label: string;
  /** 完整稱謂：乙方（承租人）。 */
  fullLabel: string;
}

/** 同一人兼任而合併的席位。簽章分流的 `MergedSeats` 符合這個形狀。 */
export interface SigningMerge {
  practitionerRuleId: string;
  partyRuleId: string;
}

/** 簽署進度的最小形狀。簽署模組回傳的 `SigningProgress` 符合。 */
export interface SigningProgressInput {
  /** 簽署任務的狀態。沒有帶時當作進行中。 */
  status?: SigningProgress['status'];
  signers: ReadonlyArray<Pick<SignerRecord, 'role' | 'name' | 'status'> & { concurrentRoles?: readonly SignerRole[] }>;
}

export type SigningStepState = 'signed' | 'current' | 'waiting' | 'declined';

export interface SigningStep {
  /** 主要角色。兼任的簽署人是 `practitioner`。 */
  role: SignerRole;
  /** 兼任的其他角色。沒有兼任是空陣列。 */
  concurrentRoles: SignerRole[];
  /** 簡稱，兼任時接「兼甲方」。 */
  label: string;
  /** 完整稱謂，兼任時接「兼甲方（出租人）」。 */
  fullLabel: string;
  /** 簽署人姓名。還沒有簽署人（尚未送簽、舊合約）時是 null。 */
  name: string | null;
  state: SigningStepState;
}

export interface SigningSteps {
  /** 一位簽署人一步，依簽署順序。 */
  steps: SigningStep[];
  /**
   * 目前位置：目前待簽的步驟索引。全員簽完是 `steps.length`，也就是「完成」那一點。
   * 不在簽署流程（草稿、已拒簽、已撤回）是 null。
   */
  position: number | null;
  /** 合約已完成。 */
  completed: boolean;
}

export interface BuildSigningStepsInput {
  status: ContractStatus;
  /** 簽署模組的簽署進度。沒有簽署任務（草稿、沒有回填的舊合約）是 null 或不帶。 */
  progress?: SigningProgressInput | null;
  /**
   * 規則表算出的簽署序列。有簽署進度時只用來取稱謂；沒有簽署進度時，步驟就由它而來。
   * 沒有時退回兩方：乙方、甲方。
   */
  seats?: readonly SigningSeat[] | null;
  /** 草稿指派同一人兼任而合併的席位。只在沒有簽署進度時用，有簽署進度時兼任角色取自簽署人。 */
  merges?: readonly SigningMerge[];
  contractType?: ContractType;
}

// 合約狀態由當前簽署人的角色投影（ADR-0010）。這裡是反向對應，只在沒有簽署任務時用來找位置。
const SIGNING_STATUS_ROLE: Partial<Record<ContractStatus, SignerRole>> = {
  awaiting_tenant: 'party_b',
  awaiting_practitioner: 'practitioner',
  awaiting_landlord: 'party_a',
};

/** 簽署中的合約狀態對應的當前簽署人角色。不在簽署中回 null。 */
export function signerRoleOfStatus(status: ContractStatus): SignerRole | null {
  return SIGNING_STATUS_ROLE[status] ?? null;
}

function roleFullLabel(role: SignerRole, contractType: ContractType): string {
  const labels = partyLabels(contractType);
  if (role === 'party_a') return labels.partyAFull;
  if (role === 'party_b') return labels.partyBFull;
  return SIGNER_ROLE_LABELS.practitioner;
}

function fallbackSeats(contractType: ContractType): SigningSeat[] {
  return (['party_b', 'party_a'] as const).map((role) => ({
    role,
    label: SIGNER_ROLE_LABELS[role],
    fullLabel: roleFullLabel(role, contractType),
  }));
}

function makeStep(
  seat: Pick<SigningSeat, 'role' | 'label' | 'fullLabel'>,
  concurrent: ReadonlyArray<Pick<SigningSeat, 'role' | 'label' | 'fullLabel'>>,
  name: string | null,
  state: SigningStepState
): SigningStep {
  return {
    role: seat.role,
    concurrentRoles: concurrent.map((c) => c.role),
    label: [seat.label, ...concurrent.map((c) => SIGNER_ROLE_LABELS[c.role])].join('兼'),
    fullLabel: [seat.fullLabel, ...concurrent.map((c) => c.fullLabel)].join('兼'),
    name,
    state,
  };
}

// 簽署人對上席位：兼任的簽署人吸收一個當事人席位，把被吸收的席位拿掉後，剩下的席位要與簽署人一一同角色。
// 對不起來就不取席位稱謂，退回角色稱謂，畫面不錯位。
function alignSeats(
  signers: SigningProgressInput['signers'],
  seats: readonly SigningSeat[] | null | undefined
): Array<SigningSeat | undefined> {
  const unaligned = signers.map(() => undefined);
  if (!seats) return unaligned;
  const remaining = [...seats];
  for (const role of signers.flatMap((s) => s.concurrentRoles ?? [])) {
    const index = remaining.findIndex((seat) => seat.role === role);
    if (index >= 0) remaining.splice(index, 1);
  }
  const matches = remaining.length === signers.length && remaining.every((seat, i) => seat.role === signers[i].role);
  return matches ? remaining : unaligned;
}

function stepsFromProgress(input: BuildSigningStepsInput, progress: SigningProgressInput): SigningSteps {
  const { status, seats } = input;
  const contractType = input.contractType ?? 'lease';
  const { signers } = progress;
  const completed = status === 'completed';
  const taskRunning = (progress.status ?? 'in_progress') === 'in_progress' && isSigningStatus(status);
  const pendingIndex = signers.findIndex((s) => s.status === 'pending');
  const aligned = alignSeats(signers, seats);

  const stateOf = (index: number): SigningStepState => {
    if (completed || signers[index].status === 'signed') return 'signed';
    if (signers[index].status === 'declined') return 'declined';
    return taskRunning && index === pendingIndex ? 'current' : 'waiting';
  };
  const labelOf = (role: SignerRole) => ({
    role,
    label: SIGNER_ROLE_LABELS[role],
    fullLabel: roleFullLabel(role, contractType),
  });
  const steps = signers.map((signer, i) =>
    makeStep(
      aligned[i] ?? labelOf(signer.role),
      (signer.concurrentRoles ?? []).map(labelOf),
      signer.name,
      stateOf(i)
    )
  );
  const position = completed ? steps.length : taskRunning ? (pendingIndex === -1 ? steps.length : pendingIndex) : null;
  return { steps, position, completed };
}

function stepsFromSequence(input: BuildSigningStepsInput): SigningSteps {
  const { status, merges = [] } = input;
  const contractType = input.contractType ?? 'lease';
  const seats = input.seats ?? fallbackSeats(contractType);
  const absorbed = new Set(merges.map((m) => m.partyRuleId));
  const planned = seats
    .filter((seat) => !seat.ruleId || !absorbed.has(seat.ruleId))
    .map((seat) => ({
      seat,
      concurrent: seat.ruleId
        ? merges
            .filter((m) => m.practitionerRuleId === seat.ruleId)
            .map((m) => seats.find((s) => s.ruleId === m.partyRuleId))
            .filter((s): s is SigningSeat => Boolean(s))
        : [],
    }));

  const completed = status === 'completed';
  const currentRole = signerRoleOfStatus(status);
  const currentIndex = currentRole ? planned.findIndex(({ seat }) => seat.role === currentRole) : -1;
  const stateOf = (index: number): SigningStepState => {
    if (completed) return 'signed';
    if (currentIndex < 0) return 'waiting';
    return index < currentIndex ? 'signed' : index === currentIndex ? 'current' : 'waiting';
  };
  const steps = planned.map(({ seat, concurrent }, i) => makeStep(seat, concurrent, null, stateOf(i)));
  const position = completed ? steps.length : currentIndex >= 0 ? currentIndex : null;
  return { steps, position, completed };
}

/**
 * 簽署進度的步驟與目前位置。
 * - 有簽署進度：步驟就是實際的簽署人，順序與人數由簽署任務決定。
 * - 沒有簽署進度（草稿、沒有回填的舊合約）：步驟由規則表算出的序列來，位置由合約狀態推出。
 * 不管哪一種都不報錯，序列與狀態對不起來時位置是 null。
 */
export function buildSigningSteps(input: BuildSigningStepsInput): SigningSteps {
  const progress = input.progress;
  return progress && progress.signers.length > 0 ? stepsFromProgress(input, progress) : stepsFromSequence(input);
}

/**
 * 球在甲方手上：工作台的待辦依當前簽署人判斷（MIL-72，重看 MIL-59）。
 * 輪到乙方、執業人員或經紀人時，球不在甲方手上。兼任甲方的簽署人輪到時算甲方，合併不改變輪到誰。
 * 沒有簽署任務的舊合約依合約狀態。
 */
export function isPartyATurn(status: ContractStatus, progress?: SigningProgressInput | null): boolean {
  if (!isSigningStatus(status)) return false;
  if (progress && progress.signers.length > 0 && (progress.status ?? 'in_progress') === 'in_progress') {
    const current = progress.signers.find((s) => s.status === 'pending');
    return Boolean(current && (current.role === 'party_a' || current.concurrentRoles?.includes('party_a')));
  }
  return status === 'awaiting_landlord';
}

export interface SigningStepDot {
  label: string;
  state: 'done' | 'current' | 'pending';
}

/** 清單的進度點：每位簽署人一點，最後多一點「完成」。不在簽署流程回 null，畫面顯示「—」。 */
export function signingStepDots(result: SigningSteps): SigningStepDot[] | null {
  const { steps, position, completed } = result;
  if (position === null) return null;
  const labels = [...steps.map((step) => `${step.label}簽`), '完成'];
  return labels.map((label, i) => ({
    label,
    state: completed || i < position ? 'done' : i === position ? 'current' : 'pending',
  }));
}

/**
 * 詳情頁要不要在每一步下列出簽署人姓名與狀態。
 * 兩方合約的畫面文字與排版不變，所以只有三位以上或有兼任時才列。
 */
export function stepsShowSignerDetail(result: SigningSteps): boolean {
  return result.steps.length > 2 || result.steps.some((step) => step.concurrentRoles.length > 0);
}

const STATE_LABELS: Record<SigningStepState, string> = {
  signed: '已簽署',
  current: '待簽署',
  waiting: '尚未輪到',
  declined: '已拒簽',
};

export function signingStepStateLabel(state: SigningStepState): string {
  return STATE_LABELS[state];
}
