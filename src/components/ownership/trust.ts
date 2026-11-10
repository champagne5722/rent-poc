import { TRUST_FIELD_LABELS, TRUST_FIELDS, type TrustField } from '@/lib/ownership/forms';

// 信託登記四項資料在畫面上的對照（MIL-180）。物件頁與審核台的謄本資料都用這一份，不各寫一張表。

/** API 回傳的信託資料欄位名稱。 */
export type TrustViewKey = 'registered_owner' | 'related_parties' | 'registration_status' | 'lease_clause';

const TRUST_VIEW_KEYS: Record<TrustField, TrustViewKey> = {
  registeredOwner: 'registered_owner',
  relatedParties: 'related_parties',
  registrationStatus: 'registration_status',
  leaseClause: 'lease_clause',
};

export const trustViewKey = (field: TrustField): TrustViewKey => TRUST_VIEW_KEYS[field];

/** 信託資料轉成 Descriptions 的項目。沒有信託登記時回空陣列。 */
export function trustDescriptionItems(trust: Partial<Record<TrustViewKey, string>> | null | undefined): Array<{ key: string; label: string; children: string }> {
  if (!trust) return [];
  return TRUST_FIELDS.map((field) => ({
    key: `trust-${field}`,
    label: `信託：${TRUST_FIELD_LABELS[field]}`,
    children: trust[trustViewKey(field)] ?? '—',
  }));
}
