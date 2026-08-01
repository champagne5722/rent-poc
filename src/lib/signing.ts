import type { Contract, SignerRole } from './types';

// 當前待簽方（見 CONTEXT.md「簽署連結」）：簽署中才有值，其餘狀態回 null。
// 純函式、無 server 相依，client 與 route 共用。
export function currentSigner(contract: Contract): { role: SignerRole; name: string; email: string } | null {
  const f = contract.fields;
  if (contract.status === 'awaiting_tenant') {
    return { role: 'tenant', name: f.tenantName, email: f.tenantEmail };
  }
  if (contract.status === 'awaiting_landlord') {
    return { role: 'landlord', name: f.landlordName, email: f.landlordEmail };
  }
  return null;
}
