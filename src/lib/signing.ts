import type { CurrentSigner, Signer } from './signing-module/provider';
import type { Contract } from './types';

// 當前待簽方（見 GLOSSARY.md「簽署連結」）：簽署中才有值，其餘狀態回 null。
// 純函式、無 server 相依，client 與 route 共用。
export function currentSigner(contract: Contract): CurrentSigner | null {
  const f = contract.fields;
  if (contract.status === 'awaiting_tenant') {
    return { role: 'tenant', name: f.tenantName, email: f.tenantEmail };
  }
  if (contract.status === 'awaiting_landlord') {
    return { role: 'landlord', name: f.landlordName, email: f.landlordEmail };
  }
  return null;
}

// 租賃合約的簽署序列：陣列順序就是簽署順序，乙方先簽、甲方後簽。
export function contractSignerSequence(contract: Contract): Signer[] {
  const { fields, signature_fields } = contract;
  return [
    {
      role: 'tenant',
      name: fields.tenantName,
      email: fields.tenantEmail,
      signatureFields: signature_fields.filter((f) => f.signer === 'tenant'),
    },
    {
      role: 'landlord',
      name: fields.landlordName,
      email: fields.landlordEmail,
      signatureFields: signature_fields.filter((f) => f.signer === 'landlord'),
    },
  ];
}

export function contractDocumentFileName(contract: Contract): string {
  return `租賃合約-${contract.fields.propertyName || contract.id}`;
}
