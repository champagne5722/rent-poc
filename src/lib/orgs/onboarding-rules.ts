// 第一次登入建組織的表單規則與登入落地規則（MIL-106，ADR-0022 決議 4、6）。純函式，沒有 I/O。

import type { IdentityOption } from '../auth/account-service';
import { checkLicenseEligibility, ENTITY_TYPES, LICENSE_KINDS, type EntityType, type LicenseKind } from '../registry-rules';

export const ORG_NAME_MAX = 80;

export type FormField = 'name' | 'taxId' | 'entityType' | 'kinds';

export type FormResult<T> =
  | { ok: true; value: T }
  | { ok: false; field: FormField; message: string; code?: 'company_required' };

const fail = (field: FormField, message: string, code?: 'company_required'): FormResult<never> => ({ ok: false, field, message, code });

function cleanName(raw: unknown): FormResult<string> {
  if (typeof raw !== 'string' || raw.trim() === '') return fail('name', '請輸入名稱');
  const name = raw.trim();
  if (name.length > ORG_NAME_MAX) return fail('name', `名稱不得超過 ${ORG_NAME_MAX} 字`);
  return { ok: true, value: name };
}

export function validateOwnerForm(input: { name?: unknown }): FormResult<{ name: string }> {
  const name = cleanName(input.name);
  return name.ok ? { ok: true, value: { name: name.value } } : name;
}

export interface PracticeForm {
  name: string;
  taxId: string;
  entityType: EntityType;
  kinds: LicenseKind[];
}

/**
 * 經理人第一次登入時填的表單。統編只檢查 8 碼數字，不算檢查碼（商工登記的核對由平台營運者人工做，ADR-0017 決議 2）。
 * 業別資格只檢查組織型態：營業項目要等平台營運者登錄才有（ADR-0017 Consequences），所以不看 missing_business_item。
 */
export function validatePracticeForm(input: {
  name?: unknown;
  taxId?: unknown;
  entityType?: unknown;
  kinds?: unknown;
}): FormResult<PracticeForm> {
  const name = cleanName(input.name);
  if (!name.ok) return name;

  const taxId = typeof input.taxId === 'string' ? input.taxId.trim() : '';
  if (!/^[0-9]{8}$/.test(taxId)) return fail('taxId', '統一編號是 8 碼數字');

  const entityType = (ENTITY_TYPES as readonly unknown[]).includes(input.entityType) ? (input.entityType as EntityType) : null;
  if (!entityType) return fail('entityType', '請選擇公司或商號');

  if (!Array.isArray(input.kinds) || input.kinds.length === 0) return fail('kinds', '請至少選一種業別');
  if (!input.kinds.every((k) => (LICENSE_KINDS as readonly unknown[]).includes(k))) return fail('kinds', '業別不在可選範圍');
  const kinds = LICENSE_KINDS.filter((k) => (input.kinds as unknown[]).includes(k));

  for (const kind of kinds) {
    const eligibility = checkLicenseEligibility({ kind, entityType, businessItemCodes: [] });
    if (!eligibility.ok) {
      const company = eligibility.reasons.find((r) => r.code === 'company_required');
      if (company) return fail('kinds', company.message, 'company_required');
    }
  }
  return { ok: true, value: { name: name.value, taxId, entityType, kinds } };
}

/**
 * 登入後的落地頁（MIL-106，MIL-94）。帳號的所有身分都是屋主組織時落到 /owner，其餘落到工作台。
 * 承租人端與審核台還沒有自己的首頁（MIL-121、MIL-109），目前都先落到工作台。
 */
export function landingPath(options: readonly IdentityOption[]): string {
  return options.length > 0 && options.every((o) => o.kind === 'owner') ? '/owner' : '/';
}

/** 切換到某個身分之後的落地頁：屋主組織到 /owner，其餘到工作台。 */
export function landingPathFor(option: IdentityOption): string {
  return option.kind === 'owner' ? '/owner' : '/';
}

export type { IdentityOption };
