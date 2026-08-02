// 建約 wizard 的步驟定義與檢核邏輯（規格 §7）。
// 全部是純函式，UI 只負責蒐集輸入與畫畫面；擋下一步、擋送簽與續作步驟推導都集中在這裡。

import type { Contract, ContractFields, SignatureField } from './types';

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

// 平台提供的唯一範本（ADR-0005）。單範本時第①步顯示為說明，不做選擇。
export const DEFAULT_TEMPLATE = {
  name: '住宅租賃契約 v1',
  provider: '平台提供',
  note: '條款全文由平台維護並經法務審閱，房東只編輯欄位。',
} as const;

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

export interface SignatureCheck {
  landlord: number;
  tenant: number;
  ok: boolean;
}

/** 簽署區檢核：甲乙雙方各至少一框（規格 §7 五點基線第 3 點）。 */
export function checkSignatureFields(signatureFields: SignatureField[]): SignatureCheck {
  const landlord = signatureFields.filter((f) => f.signer === 'landlord').length;
  const tenant = signatureFields.filter((f) => f.signer === 'tenant').length;
  return { landlord, tenant, ok: landlord > 0 && tenant > 0 };
}

function signatureBlockReason(signatureFields: SignatureField[]): string | null {
  const check = checkSignatureFields(signatureFields);
  if (check.ok) return null;
  return `請為甲乙雙方各設定至少一個簽名框（目前甲方 ${check.landlord} 個、乙方 ${check.tenant} 個）`;
}

function fieldsBlockReason(fields: ContractFields): string | null {
  const missing = missingFieldLabels(fields);
  return missing.length ? `請先完成欄位：${missing.join('、')}` : null;
}

/** 按「下一步」時的擋下理由；通過回 null。第①步的物件在建立草稿時已綁定，不再擋。 */
export function nextStepBlockReason(stepIndex: number, state: WizardState): string | null {
  if (stepIndex === STEP_FIELDS) return fieldsBlockReason(state.fields);
  if (stepIndex === STEP_SIGNATURE) return signatureBlockReason(state.signatureFields);
  return null;
}

/** 第④步送簽前的最終檢核：欄位缺漏優先回報，其次簽署區。 */
export function sendBlockReason(state: WizardState): string | null {
  return fieldsBlockReason(state.fields) ?? signatureBlockReason(state.signatureFields);
}

/**
 * 中斷後續作要落在哪一步：先補未完成的欄位，再補簽署區，都齊全就直接到確認頁。
 * 第①步只是物件與範本說明，續作不會停在那裡。
 */
export function resumeStepIndex(contract: Contract): number {
  if (missingFieldLabels(contract.fields).length) return STEP_FIELDS;
  if (!checkSignatureFields(contract.signature_fields).ok) return STEP_SIGNATURE;
  return STEP_CONFIRM;
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
