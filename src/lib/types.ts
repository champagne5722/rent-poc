// 領域型別與詞彙，術語定義見 repo 根目錄 CONTEXT.md

export const PROPERTY_TYPES = ['整層住家', '套房', '雅房'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const EQUIPMENT_OPTIONS = [
  '冷氣',
  '洗衣機',
  '冰箱',
  '熱水器',
  '床',
  '衣櫃',
  '書桌',
  '網路',
  '第四台',
  '瓦斯爐',
] as const;

export interface Property {
  id: number;
  name: string;
  address: string;
  type: PropertyType;
  size: number | null;
  default_rent: number | null;
  note: string;
  equipment: string[];
  created_at: string;
  updated_at: string | null;
}

export const CONTRACT_STATUSES = [
  'draft',
  'awaiting_tenant',
  'awaiting_landlord',
  'completed',
  'declined',
  'voided',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: '草稿',
  awaiting_tenant: '待乙方簽',
  awaiting_landlord: '待甲方簽',
  completed: '已完成',
  declined: '已拒簽',
  voided: '已撤回',
};

// 合約欄位值：建立時由物件帶入快照，之後與物件脫鉤（見 docs/domain-model.md）
export interface ContractFields {
  landlordName: string;
  landlordEmail: string;
  tenantName: string;
  tenantEmail: string;
  propertyName: string;
  propertyAddress: string;
  propertyType: string;
  propertySize: number | null;
  equipment: string[];
  rent: number | null;
  deposit: number | null; // 押金（元）
  startDate: string; // YYYY-MM-DD
  endDate: string;
  payDay: number | null; // 每月付款日
  extra: string; // 其他約定事項
}

export type SignerRole = 'landlord' | 'tenant';

// 簽署區域：座標為「相對該頁的比例值」（0~1，原點左上、y 向下，同瀏覽器慣例）。
// 送簽時由 dottedsign.ts 轉成 PDF points（原點左下）。
export interface SignatureField {
  id: string;
  signer: SignerRole;
  page: number; // 0-based
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Contract {
  id: number;
  property_id: number | null;
  status: ContractStatus;
  fields: ContractFields;
  signature_fields: SignatureField[];
  dottedsign_task_id: string | null;
  declined_reason: string | null;
  created_at: string;
  updated_at: string | null;
}

// 合約歷程（見 CONTEXT.md、ADR-0007）：附屬合約的 append-only 里程碑事件。
// 只記這七種；草稿編輯流水與下載／查看等讀式操作不記。
export const CONTRACT_EVENT_TYPES = [
  'created', // 建立（衍生自撤回合約時附註來源）
  'sent', // 送簽
  'tenant_signed', // 乙方簽署
  'declined', // 拒簽（附註原因）
  'completed', // 甲方簽署完成
  'voided', // 撤回
  'copied', // 被複製為新草稿
] as const;
export type ContractEventType = (typeof CONTRACT_EVENT_TYPES)[number];

export const CONTRACT_EVENT_TYPE_LABELS: Record<ContractEventType, string> = {
  created: '建立合約',
  sent: '送簽',
  tenant_signed: '乙方簽署',
  declined: '拒簽',
  completed: '甲方簽署完成',
  voided: '撤回',
  copied: '被複製為新草稿',
};

export const CONTRACT_EVENT_ACTORS = ['landlord', 'tenant', 'system'] as const;
export type ContractEventActor = (typeof CONTRACT_EVENT_ACTORS)[number];

export const CONTRACT_EVENT_ACTOR_LABELS: Record<ContractEventActor, string> = {
  landlord: '房東',
  tenant: '租客',
  system: '系統',
};

export interface ContractEvent {
  id: number;
  contract_id: number;
  type: ContractEventType;
  actor: ContractEventActor;
  note: string | null;
  created_at: string;
}
