// 建約 wizard 的步驟定義與檢核邏輯（規格 §7）。
// 全部是純函式，UI 只負責蒐集輸入與畫畫面；擋下一步、擋送簽與續作步驟推導都集中在這裡。

import { upgradedTemplateBinding } from './clause-library';
import { contractEquipmentAnnex } from './equipment';
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
  ContractTemplate,
  OptionalClause,
  SignatureField,
} from './types';

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

// 乙方先簽（ADR-0003）：確認頁對房東說明送簽後的預期。
export const TENANT_FIRST_NOTICE =
  '送簽後由乙方（租客）先簽，乙方完成後才輪到甲方（您）簽署，雙方都簽完合約才成立。';

/** wizard 檢核看得到的狀態；欄位日期一律是 YYYY-MM-DD 字串。 */
export interface WizardState {
  fields: ContractFields;
  signatureFields: SignatureField[];
}

const EMAIL_PATTERN = /.+@.+\..+/;

/**
 * 第②步的必填欄位檢核，回傳缺漏欄位的標籤。
 * 必填集合與 POST /api/contracts/[id]/send 的後端驗證一致，額外多擋租期方向顛倒。
 */
export function missingFieldLabels(fields: ContractFields): string[] {
  const missing: string[] = [];
  if (!fields.landlordName.trim()) missing.push('甲方姓名');
  if (!EMAIL_PATTERN.test(fields.landlordEmail)) missing.push('甲方 Email');
  if (!fields.tenantName.trim()) missing.push('乙方姓名');
  if (!EMAIL_PATTERN.test(fields.tenantEmail)) missing.push('乙方 Email');
  if (fields.rent == null) missing.push('月租金');
  if (!fields.startDate) missing.push('租期起日');
  if (!fields.endDate) missing.push('租期迄日');
  else if (fields.startDate && fields.endDate < fields.startDate) {
    missing.push('租期迄日（不得早於起日）');
  }
  return missing;
}

/** 第②步表單真正編輯的欄位；日期在 UI 端轉成 YYYY-MM-DD 字串後才進來。 */
export type EditableFieldValues = Partial<
  Pick<
    ContractFields,
    | 'landlordName'
    | 'landlordEmail'
    | 'tenantName'
    | 'tenantEmail'
    | 'rent'
    | 'deposit'
    | 'startDate'
    | 'endDate'
    | 'payDay'
    | 'extra'
  >
>;

/**
 * 把第②步表單的值併回草稿欄位快照。
 * 底稿是草稿當下的完整欄位：物件快照、範本綁定與第①步勾選的條款快照都原樣留著，
 * 只有表單管的那幾個欄位被覆蓋；沒填的正規化成空字串或 null，不讓 undefined 進資料庫。
 */
export function mergeEditableFields(base: ContractFields, values: EditableFieldValues): ContractFields {
  return {
    ...base,
    landlordName: values.landlordName ?? '',
    landlordEmail: values.landlordEmail ?? '',
    tenantName: values.tenantName ?? '',
    tenantEmail: values.tenantEmail ?? '',
    rent: values.rent ?? null,
    deposit: values.deposit ?? null,
    startDate: values.startDate ?? '',
    endDate: values.endDate ?? '',
    payDay: values.payDay ?? null,
    extra: values.extra ?? '',
  };
}

/**
 * 草稿升版重建（ADR-0005）：綁上平台最新範本版本、已勾條款重取最新條文，
 * 並把 v1 只有壓平字串的設備欄位轉成範本 v2 的設備附件列（ADR-0008）。
 * 回傳新物件，原草稿欄位不被就地改寫。
 */
export function upgradeDraftFields(
  fields: ContractFields,
  options: { template?: ContractTemplate; library?: readonly OptionalClause[] } = {}
): ContractFields {
  return {
    ...fields,
    ...upgradedTemplateBinding(fields, options),
    equipmentAnnex: contractEquipmentAnnex(fields),
    // 轉出附件列後舊欄位就沒有用途了；undefined 在 JSON.stringify 時會被丟掉
    equipment: undefined,
  };
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

function fieldsBlockReason(fields: ContractFields): string | null {
  const missing = missingFieldLabels(fields);
  return missing.length ? `請先完成欄位：${missing.join('、')}` : null;
}

/** 按「下一步」時的擋下理由；通過回 null。第①步的物件在建立草稿時已綁定，只檢查分流條件。 */
export function nextStepBlockReason(stepIndex: number, state: WizardState): string | null {
  if (stepIndex === STEP_PROPERTY) return routingBlockReason(state.fields);
  if (stepIndex === STEP_FIELDS) return fieldsBlockReason(state.fields);
  if (stepIndex === STEP_SIGNATURE) return signatureBlockReason(state.fields, state.signatureFields);
  return null;
}

/**
 * 第④步送簽前的全部擋下原因，一次列完：欄位缺漏、分流條件、缺少的簽署區域、尚未指派的執業人員。
 * 規則要求執業人員但尚未指派時擋下送簽。指派執業人員的欄位屬 MIL-69，在那之前每個執業人員席位都算未指派。
 */
export function sendBlockReasons(state: WizardState): string[] {
  const reasons: string[] = [];
  const fieldsReason = fieldsBlockReason(state.fields);
  if (fieldsReason) reasons.push(fieldsReason);

  const evaluation = evaluateRouting(state.fields.routing);
  if (!evaluation.ok) {
    reasons.push(evaluation.reason);
    return reasons;
  }
  const signatureReason = signatureBlockReason(state.fields, state.signatureFields);
  if (signatureReason) reasons.push(signatureReason);
  for (const seat of evaluation.seats) {
    if (seat.role === 'practitioner') reasons.push(`尚未指派${seat.label}`);
  }
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
  if (missingFieldLabels(contract.fields).length) return STEP_FIELDS;
  if (signatureBlockReason(contract.fields, contract.signature_fields)) return STEP_SIGNATURE;
  return STEP_CONFIRM;
}

/** 確認頁的簽署順序說明。乙方先簽、甲方後簽的序列沿用原文字，其他序列由席位產生。 */
export function signingSequenceNotice(fields: ContractFields): string {
  const evaluation = evaluateRouting(fields.routing);
  if (!evaluation.ok || isPartiesOnly(evaluation.seats)) return TENANT_FIRST_NOTICE;
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

export type WizardStepStatus = 'wait' | 'process' | 'finish' | 'error';

/** Steps 各步的狀態：目前步驟 process、未走到 wait、走過但檢核未過標 error。 */
export function stepStatuses(current: number, state: WizardState): WizardStepStatus[] {
  return WIZARD_STEPS.map((_, index) => {
    if (index > current) return 'wait';
    if (index === current) return 'process';
    return nextStepBlockReason(index, state) ? 'error' : 'finish';
  });
}
