// 包租合約與轉租合約的共用定義（MIL-199、ADR-0030 決議 6）。
// 兩種合約的欄位都是租賃類共用欄位（`LeaseTermsFields`）加上自己的選項，當事人取值、清單摘要與建立草稿的做法與租賃合約相同，
// 差別是範本、稱謂、分流條件快照、公告規定的檢核（租期不得少於三十日、押金不得超過二個月租金），
// 與現況確認附件（只有轉租合約）。各自的定義在 master-lease.ts 與 sublease.ts。

import { bindTemplate } from '../clause-library';
import { toEquipmentAnnex } from '../equipment';
import { depositWithinLimit, leaseTermDays, MIN_LEASE_TERM_DAYS } from '../lease-family-terms';
import type { ContractType } from '../labels';
import { currentTemplate } from '../template-registry';
import type { ContractPartyRole, LeaseTermsFields } from '../types';
import { routingSnapshotFor } from './case-kind';
import type { ContractListSummary, InitialFieldsInput, PartyIdentity } from './types';

const EMAIL_PATTERN = /.+@.+\..+/;

export type LeaseFamilyNewType = Extract<ContractType, 'master_lease' | 'sublease'>;

/** 租期的公告限制：不得少於三十日。起迄沒填完或順序顛倒由其他檢核處理，這裡回 false。 */
export function termTooShort(startDate: string, endDate: string): boolean {
  const days = leaseTermDays(startDate, endDate);
  return days !== null && days < MIN_LEASE_TERM_DAYS;
}

/**
 * 兩方當事人與租金、押金、租期的必填檢核，標籤由呼叫端給（包租合約與轉租合約的稱謂不同）。
 * 公告限制一併檢核：租期不得少於三十日，押金最高不得超過二個月租金。
 */
export function leaseFamilyMissingFields(
  f: LeaseTermsFields,
  labels: { partyA: readonly [string, string]; partyB: readonly [string, string] },
): string[] {
  const missing: string[] = [];
  if (!f.landlordName.trim()) missing.push(labels.partyA[0]);
  if (!EMAIL_PATTERN.test(f.landlordEmail)) missing.push(labels.partyA[1]);
  if (!f.tenantName.trim()) missing.push(labels.partyB[0]);
  if (!EMAIL_PATTERN.test(f.tenantEmail)) missing.push(labels.partyB[1]);
  if (f.rent == null) missing.push('月租金');
  if (!f.startDate) missing.push('租期起日');
  if (!f.endDate) missing.push('租期迄日');
  else if (f.startDate && f.endDate < f.startDate) missing.push('租期迄日（不得早於起日）');
  else if (f.startDate && termTooShort(f.startDate, f.endDate)) missing.push('租期（不得少於三十日）');
  if (!depositWithinLimit(f.rent, f.deposit)) missing.push('押金（最高不得超過二個月租金）');
  return missing;
}

export function leaseFamilyParty(fields: LeaseTermsFields, role: ContractPartyRole): PartyIdentity {
  return role === 'party_a'
    ? { name: fields.landlordName, email: fields.landlordEmail }
    : { name: fields.tenantName, email: fields.tenantEmail };
}

export function leaseFamilyWithParty<F extends LeaseTermsFields>(fields: F, role: ContractPartyRole, person: PartyIdentity): F {
  return role === 'party_a'
    ? { ...fields, landlordName: person.name, landlordEmail: person.email }
    : { ...fields, tenantName: person.name, tenantEmail: person.email };
}

export function leaseFamilyListSummary(fields: LeaseTermsFields): ContractListSummary {
  return {
    propertyName: fields.propertyName || null,
    rent: fields.rent,
    partyB: { name: fields.tenantName, email: fields.tenantEmail },
    period: fields.startDate && fields.endDate ? [fields.startDate, fields.endDate] : null,
  };
}

/**
 * 從物件建立草稿：物件資料帶入成快照，之後與物件脫鉤；範本綁定該類型最新的版本，沒有選用條款。
 * 設備清單帶入成設備附件列，條文把它列在租賃標的。分流條件快照由合約類型決定，只有「是否有經紀業者居間」取自輸入。
 */
export function leaseFamilyInitialFields(type: LeaseFamilyNewType, { property, routing }: InitialFieldsInput): LeaseTermsFields {
  if (!property) throw new Error(type === 'master_lease' ? '包租合約需要物件' : '轉租合約需要物件');
  const template = currentTemplate(type);
  return {
    routing: routingSnapshotFor(type, routing?.brokerMediated === true),
    landlordName: '',
    landlordEmail: '',
    tenantName: '',
    tenantEmail: '',
    propertyName: property.name,
    propertyAddress: property.address,
    propertyType: property.type,
    propertySize: property.size,
    equipmentAnnex: toEquipmentAnnex(property.equipment),
    rent: property.default_rent,
    deposit: property.default_rent != null ? property.default_rent * 2 : null,
    startDate: '',
    endDate: '',
    payDay: 5,
    extra: '',
    ...(template ? bindTemplate([], { template, library: [] }) : {}),
  };
}
