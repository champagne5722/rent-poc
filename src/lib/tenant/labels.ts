import type { ContractStatus } from '../types';

// 承租人端看到的合約狀態用語（MIL-121）。後台的 CONTRACT_STATUS_LABELS 寫「待乙方簽」「待甲方簽」，
// 是出租人視角；承租人端改用承租人看得懂的說法，不出現甲方、乙方。
export const TENANT_CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: '出租人準備中',
  awaiting_tenant: '等待你簽署',
  awaiting_practitioner: '簽署中',
  awaiting_landlord: '簽署中',
  completed: '已簽署完成',
  declined: '已拒簽',
  voided: '已撤回',
};

export function tenantContractStatusLabel(status: string | null): string {
  if (status === null) return '尚無合約';
  return TENANT_CONTRACT_STATUS_LABELS[status as ContractStatus] ?? '—';
}
