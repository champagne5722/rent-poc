// 業別規則（PRD P0-03 規則 1、2、7，ADR-0017 決議 4、5）。純函式，沒有 I/O。

import type { LicenseKind } from '../labels';
import { decideCredentialTransition, type CredentialState, type CredentialTransition } from './credential-transition';

export type { LicenseKind };

/** 業別。一個執業主體得兼營多種業別。 */
export const LICENSE_KINDS = ['management', 'master_lease', 'brokerage'] as const satisfies readonly LicenseKind[];

/** 業別對應的營業項目代碼。H703100 不構成代管業資格（P0-03 規則 1）。 */
export const REQUIRED_BUSINESS_ITEM_CODE: Record<LicenseKind, string> = {
  management: 'H706011',
  master_lease: 'H706021',
  brokerage: 'H704031',
};

/** 執業主體的組織型態：公司或商號。 */
export const ENTITY_TYPES = ['company', 'firm'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** 代管與包租限公司，經紀得為公司或商號（P0-03 規則 2、3）。 */
const COMPANY_ONLY: readonly LicenseKind[] = ['management', 'master_lease'];

export interface LicenseEligibilityInput {
  kind: LicenseKind;
  entityType: EntityType;
  /** 平台營運者登錄的營業項目代碼（ADR-0017 Consequences）。 */
  businessItemCodes: readonly string[];
}

export type LicenseShortfall =
  | { code: 'missing_business_item'; kind: LicenseKind; missing: string; message: string }
  | { code: 'company_required'; kind: LicenseKind; message: string };

export type LicenseEligibility = { ok: true } | { ok: false; reasons: LicenseShortfall[] };

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * 業別能不能登錄。被擋下時回傳全部原因，畫面顯示缺少的項目（P0-03 AC2、AC3）。
 * 原因順序固定：先組織型態，再營業項目。
 */
export function checkLicenseEligibility(input: LicenseEligibilityInput): LicenseEligibility {
  const reasons: LicenseShortfall[] = [];

  if (COMPANY_ONLY.includes(input.kind) && input.entityType !== 'company') {
    reasons.push({
      code: 'company_required',
      kind: input.kind,
      message: '代管與包租業別必須由公司登錄（租賃線限公司）',
    });
  }

  const required = REQUIRED_BUSINESS_ITEM_CODE[input.kind];
  if (!input.businessItemCodes.some((code) => normalizeCode(code) === required)) {
    reasons.push({
      code: 'missing_business_item',
      kind: input.kind,
      missing: required,
      message: `缺少營業項目 ${required}`,
    });
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/** 商工登記的登記狀態中，視為有效的值。 */
export const REGISTRATION_APPROVED = '核准設立';

export function isRegistrationApproved(registrationStatus: string): boolean {
  return registrationStatus.trim() === REGISTRATION_APPROVED;
}

export interface RegistrationLossInput {
  /** 平台營運者登錄的登記狀態。 */
  registrationStatus: string;
  licenses: ReadonlyArray<{ id: string; state: CredentialState }>;
}

/**
 * 登記狀態不是核准設立時，全部已驗證的業別轉 lapsed（ADR-0017 決議 5）。
 * 待驗證與已失效的業別不動，因為轉移表只有 verified 到 lapsed。
 */
export function decideRegistrationLoss(
  input: RegistrationLossInput,
): Array<{ licenseId: string; transition: CredentialTransition }> {
  if (isRegistrationApproved(input.registrationStatus)) return [];
  const result: Array<{ licenseId: string; transition: CredentialTransition }> = [];
  for (const license of input.licenses) {
    const transition = decideCredentialTransition(license.state, {
      layer: 'license',
      event: { type: 'registration_lost' },
    });
    if (transition) result.push({ licenseId: license.id, transition });
  }
  return result;
}
