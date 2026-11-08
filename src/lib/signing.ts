import type { Signer } from './signing-module/provider';
import type { Contract } from './types';

// 當前簽署人由簽署進度推導（ADR-0010），這裡只組送簽的輸入。
// 租賃合約的簽署序列：陣列順序就是簽署順序，乙方先簽、甲方後簽。
export function contractSignerSequence(contract: Contract): Signer[] {
  const { fields, signature_fields } = contract;
  return [
    {
      role: 'party_b',
      name: fields.tenantName,
      email: fields.tenantEmail,
      signatureFields: signature_fields.filter((f) => f.signer === 'party_b'),
    },
    {
      role: 'party_a',
      name: fields.landlordName,
      email: fields.landlordEmail,
      signatureFields: signature_fields.filter((f) => f.signer === 'party_a'),
    },
  ];
}

export function contractDocumentFileName(contract: Contract): string {
  return `租賃合約-${contract.fields.propertyName || contract.id}`;
}
