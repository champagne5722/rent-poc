// 建約 wizard 的步驟定義與檢核邏輯（規格 §7）。
// 全部是純函式，UI 只負責蒐集輸入與畫畫面；擋下一步、擋送簽與續作步驟推導都集中在這裡。

import {
  DEFAULT_CONTRACT_TYPE,
  TENANT_FIRST_NOTICE,
  contractTypeDefinition,
  mergeEditableFields,
  partyFieldLabels,
  upgradeDraftFields,
  type EditableFieldValues,
} from './contract-types';
import { entityPartyRoles, partyRoleOfEntitySource, type PractitionerAssignmentInput } from './practitioner-assignment/seats';
import {
  countFieldsBySeat,
  evaluateRouting,
  hasPractitionerSeat,
  reconcileSignatureFields,
  type SeatView,
} from './signature-routing';
import type {
  Contract,
  ContractFields,
  ContractPartyRole,
  ContractRoutingConditions,
  SignatureField,
} from './types';
import type { ContractType } from './labels';
import { SIGNER_ROLE_LABELS } from './types';

export const WIZARD_STEPS = [
  { key: 'property', title: '物件與範本' },
  { key: 'fields', title: '填寫欄位' },
  { key: 'signature', title: '預覽與簽署區' },
  { key: 'confirm', title: '確認送簽' },
] as const;

export type WizardStepKey = (typeof WIZARD_STEPS)[number]['key'];

export const STEP_PROPERTY = 0;
export const STEP_FIELDS = 1;
export const STEP_SIGNATURE = 2;
export const STEP_CONFIRM = 3;

// 平台提供的範本與選用條款庫定義在 src/lib/clause-library.ts（ADR-0005）。
// 單範本時第①步的範本區顯示為說明不做選擇，選用條款則在該步逐約勾選。

// 租賃合約專用的欄位表單轉換、升版重建與乙方先簽說明，定義在 contract-types/lease.ts（MIL-73）。
// 這裡原樣匯出，原本從這個模組引用的程式與測試不必改。
export { TENANT_FIRST_NOTICE, mergeEditableFields, upgradeDraftFields, type EditableFieldValues };

/** wizard 檢核看得到的狀態；欄位日期一律是 YYYY-MM-DD 字串。 */
export interface WizardState {
  /** 合約類型，欄位檢核與稱謂依它查類型定義。沒有帶（既有呼叫與測試）視為租賃合約。 */
  contractType?: ContractType;
  fields: ContractFields;
  signatureFields: SignatureField[];
  /** 執業人員的指派（MIL-69）。沒有帶（舊用法）時不檢查指派。 */
  assignments?: readonly PractitionerAssignmentInput[];
}

/**
 * 第②步的必填欄位檢核，回傳缺漏欄位的標籤。依合約類型檢核，必填集合由類型定義決定。
 * @param contractType 沒有帶視為租賃合約。
 */
export function missingFieldLabels(fields: ContractFields, contractType: ContractType = DEFAULT_CONTRACT_TYPE): string[] {
  return contractTypeDefinition(contractType).missingFields(fields);
}

export type SignatureCheck = Record<ContractPartyRole, number> & { ok: boolean };

/** 兩方簽署序列的簽署區檢核：甲乙雙方各至少一框（規格 §7 五點基線第 3 點）。 */
export function checkSignatureFields(signatureFields: SignatureField[]): SignatureCheck {
  const partyA = signatureFields.filter((f) => f.signer === 'party_a').length;
  const partyB = signatureFields.filter((f) => f.signer === 'party_b').length;
  return { party_a: partyA, party_b: partyB, ok: partyA > 0 && partyB > 0 };
}

/** 兩方簽署序列（沒有執業人員席位）沿用原本的畫面文字，自管租賃合約的畫面不變。 */
export function isPartiesOnly(seats: readonly SeatView[]): boolean {
  return !hasPractitionerSeat(seats);
}

/** 分流條件的擋下理由：規則表沒有定義的組合、形狀不對的值。通過回 null。 */
export function routingBlockReason(fields: ContractFields): string | null {
  const evaluation = evaluateRouting(fields.routing);
  return evaluation.ok ? null : evaluation.reason;
}

/** 依簽署序列檢核簽署區：每個簽署席位至少一個簽署區域（ADR-0021 決議 5）。 */
function signatureBlockReason(fields: ContractFields, signatureFields: SignatureField[]): string | null {
  const evaluation = evaluateRouting(fields.routing);
  if (!evaluation.ok) return evaluation.reason;
  const counts = countFieldsBySeat(signatureFields, evaluation.seats);
  const missing = counts.filter((c) => c.count === 0);
  if (missing.length === 0) return null;
  if (isPartiesOnly(evaluation.seats)) {
    const count = (role: ContractPartyRole) => counts.find((c) => c.seat.role === role)?.count ?? 0;
    return `請為甲乙雙方各設定至少一個簽名框（目前甲方 ${count('party_a')} 個、乙方 ${count('party_b')} 個）`;
  }
  return `請為下列簽署席位各設定至少一個簽名框：${missing.map((c) => c.seat.fullLabel).join('、')}`;
}

/** 執業主體是甲方或乙方的角色中，還沒有選定當事人簽署人的。 */
function unassignedPartySigners(
  fields: ContractFields,
  assignments: readonly PractitionerAssignmentInput[],
): ContractPartyRole[] {
  const evaluation = evaluateRouting(fields.routing);
  if (!evaluation.ok) return [];
  return entityPartyRoles(evaluation.plan).filter((role) => {
    const seat = evaluation.plan.seats.find(
      (s) => s.practitioner && partyRoleOfEntitySource(s.practitioner.entitySource) === role,
    );
    const assignment = assignments.find((a) => a.slot === seat?.ruleId);
    return !assignment?.partySignerId;
  });
}

/**
 * 第②步的擋下理由。執業主體是甲方或乙方時，那一方的姓名與 email 由當事人簽署人帶入，
 * 所以還沒選簽署人時，不把那一方的欄位列為缺漏，改提示先選簽署人。
 */
function fieldsBlockReason(
  contractType: ContractType,
  fields: ContractFields,
  assignments?: readonly PractitionerAssignmentInput[],
): string | null {
  const unassigned = assignments ? unassignedPartySigners(fields, assignments) : [];
  const skipped = new Set(unassigned.flatMap((role) => partyFieldLabels(contractType, role)));
  const missing = missingFieldLabels(fields, contractType).filter((label) => !skipped.has(label));
  if (missing.length) return `請先完成欄位：${missing.join('、')}`;
  if (unassigned.length) return `請先指派${SIGNER_ROLE_LABELS[unassigned[0]]}的當事人簽署人`;
  return null;
}

/** 按「下一步」時的擋下理由；通過回 null。第①步的物件在建立草稿時已綁定，只檢查分流條件。 */
function typeOfState(state: WizardState): ContractType {
  return state.contractType ?? DEFAULT_CONTRACT_TYPE;
}

export function nextStepBlockReason(stepIndex: number, state: WizardState): string | null {
  if (stepIndex === STEP_PROPERTY) return routingBlockReason(state.fields);
  if (stepIndex === STEP_FIELDS) return fieldsBlockReason(typeOfState(state), state.fields, state.assignments);
  if (stepIndex === STEP_SIGNATURE) return signatureBlockReason(state.fields, state.signatureFields);
  return null;
}

/**
 * 指派不完整的原因：每個執業人員席位要有指派，執業主體是甲方或乙方時還要有當事人簽署人。
 * 資格（可簽章、專任、證書種類）由伺服器的送簽前檢查判定，不在 wizard 重算。
 */
function assignmentReasons(fields: ContractFields, assignments: readonly PractitionerAssignmentInput[]): string[] {
  const evaluation = evaluateRouting(fields.routing);
  if (!evaluation.ok) return [];
  const reasons: string[] = [];
  for (const seat of evaluation.plan.seats) {
    if (!seat.practitioner) continue;
    const assignment = assignments.find((a) => a.slot === seat.ruleId);
    const label = evaluation.seats.find((v) => v.ruleId === seat.ruleId)!.label;
    // 草稿中只選了執業主體、還沒選執業人員時，practitionerId 是空字串
    if (!assignment || !assignment.practitionerId) {
      reasons.push(`尚未指派${label}`);
      continue;
    }
    const partyRole = partyRoleOfEntitySource(seat.practitioner.entitySource);
    if (partyRole && !assignment.partySignerId) reasons.push(`尚未指派${SIGNER_ROLE_LABELS[partyRole]}的當事人簽署人`);
  }
  return reasons;
}

/**
 * 第④步送簽前的全部擋下原因，一次列完：欄位缺漏、分流條件、缺少的簽署區域、尚未指派的執業人員。
 * 規則要求執業人員但尚未指派時擋下送簽。
 */
export function sendBlockReasons(state: WizardState): string[] {
  const reasons: string[] = [];
  const fieldsReason = fieldsBlockReason(typeOfState(state), state.fields);
  if (fieldsReason) reasons.push(fieldsReason);

  const evaluation = evaluateRouting(state.fields.routing);
  if (!evaluation.ok) {
    reasons.push(evaluation.reason);
    return reasons;
  }
  const signatureReason = signatureBlockReason(state.fields, state.signatureFields);
  if (signatureReason) reasons.push(signatureReason);
  reasons.push(...assignmentReasons(state.fields, state.assignments ?? []));
  return reasons;
}

/** 第④步送簽前的最終檢核：第一條擋下原因，欄位缺漏優先回報。 */
export function sendBlockReason(state: WizardState): string | null {
  return sendBlockReasons(state)[0] ?? null;
}

/**
 * 中斷後續作要落在哪一步：分流條件有問題回第①步，再補未完成的欄位與簽署區，都齊全就直接到確認頁。
 * 分流條件正常時第①步只是物件與範本說明，續作不會停在那裡。
 */
export function resumeStepIndex(contract: Contract): number {
  if (routingBlockReason(contract.fields)) return STEP_PROPERTY;
  if (missingFieldLabels(contract.fields, contract.contract_type).length) return STEP_FIELDS;
  if (signatureBlockReason(contract.fields, contract.signature_fields)) return STEP_SIGNATURE;
  return STEP_CONFIRM;
}

/** 確認頁的簽署順序說明。乙方先簽、甲方後簽的序列沿用原文字，其他序列由席位產生。 */
export function signingSequenceNotice(fields: ContractFields, contractType: ContractType = DEFAULT_CONTRACT_TYPE): string {
  const evaluation = evaluateRouting(fields.routing);
  const partiesOnlyNotice = contractTypeDefinition(contractType).partiesOnlyNotice;
  // 分流條件無效時沒有序列可說明，沿用類型定義的兩方說明
  if (!evaluation.ok) return partiesOnlyNotice ?? '';
  if (partiesOnlyNotice && isPartiesOnly(evaluation.seats)) return partiesOnlyNotice;
  const order = evaluation.seats.map((seat) => seat.fullLabel).join('、');
  return `送簽後依序簽署：${order}。每位簽完才輪到下一位，全部簽完合約才成立。`;
}

export interface RoutingChange {
  fields: ContractFields;
  signatureFields: SignatureField[];
  /** 因簽署序列沒有該角色而移除的簽署區域數。 */
  removed: number;
}

/**
 * 第①步改分流條件：寫入 `fields.routing`，並依新的簽署序列整理簽署區域。
 * 規則未定義的組合沒有序列，只寫入條件、不動簽署區域，由擋下一步的檢核要求使用者改條件。
 */
export function applyRoutingChange(
  fields: ContractFields,
  signatureFields: SignatureField[],
  routing: ContractRoutingConditions,
): RoutingChange {
  const next = { ...fields, routing };
  const evaluation = evaluateRouting(routing);
  if (!evaluation.ok) return { fields: next, signatureFields, removed: 0 };
  const reconciled = reconcileSignatureFields(signatureFields, evaluation.seats);
  return { fields: next, signatureFields: reconciled.fields, removed: reconciled.removed };
}

/** 分流條件改變後，指派只留簽署序列還有的執業人員席位。分流條件無效時全部移除。 */
export function pruneAssignments(
  routing: ContractRoutingConditions | undefined,
  assignments: readonly PractitionerAssignmentInput[],
): PractitionerAssignmentInput[] {
  const evaluation = evaluateRouting(routing);
  if (!evaluation.ok) return [];
  const slots = new Set(evaluation.plan.seats.filter((s) => s.practitioner).map((s) => s.ruleId));
  return assignments.filter((a) => slots.has(a.slot));
}

/** 選定當事人簽署人後，把姓名與 email 帶入那一方的合約欄位（欄位名稱依合約類型）。回傳新物件。 */
export function applyPartySigner(
  fields: ContractFields,
  role: ContractPartyRole,
  signer: { name: string; email: string },
  contractType: ContractType = DEFAULT_CONTRACT_TYPE,
): ContractFields {
  return contractTypeDefinition(contractType).withParty(fields, role, signer);
}

export type WizardStepStatus = 'wait' | 'process' | 'finish' | 'error';

/** Steps 各步的狀態：目前步驟 process、未走到 wait、走過但檢核未過標 error。 */
export function stepStatuses(current: number, state: WizardState): WizardStepStatus[] {
  return WIZARD_STEPS.map((_, index) => {
    if (index > current) return 'wait';
    if (index === current) return 'process';
    return nextStepBlockReason(index, state) ? 'error' : 'finish';
  });
}
