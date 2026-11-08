// 移交畫面的屋主用語。只放純資料與格式化，client 與 server 都能用。
import type { PracticeEntityStatus, ReceiverMandate } from './preconditions';
import type { SnapshotItem } from './snapshot';
import type { HandoverTarget } from './store';
import type { HandoverState } from './transitions';

export const HANDOVER_STATE_LABELS: Record<HandoverState, string> = {
  draft: '草稿',
  owner_confirmed: '等待接收方接手',
  accepted: '等待生效',
  released: '交出側已生效',
  completed: '已完成',
  cancelled: '已取消',
};

/** antd Tag 的 color。只用 DESIGN.md 的狀態色與 primary 派生的 processing。 */
export const HANDOVER_STATE_COLORS: Record<HandoverState, string> = {
  draft: 'default',
  owner_confirmed: 'processing',
  accepted: 'processing',
  released: 'warning',
  completed: 'success',
  cancelled: 'default',
};

export const PRACTICE_ENTITY_STATUS_LABELS: Record<PracticeEntityStatus, string> = {
  pending: '待驗證',
  verified: '已驗證',
  lapsed: '已失效',
};

export const PRACTICE_ENTITY_STATUS_COLORS: Record<PracticeEntityStatus, string> = {
  pending: 'warning',
  verified: 'success',
  lapsed: 'error',
};

export const RECEIVER_MANDATE_LABELS: Record<ReceiverMandate, string> = {
  valid: '有效委託',
  paper: '紙本契約書',
  none: '沒有委託',
};

const LEASE_AUTHORITY_LABELS: Record<string, string> = {
  verified: '已驗證',
  pending: '待驗證',
  failed: '驗證失敗',
  lapsed: '已失效',
};

const REPAIR_STATUS_LABELS: Record<string, string> = {
  reported: '已報修',
  in_progress: '處理中',
  done: '已完成',
};

export function targetLabel(target: HandoverTarget | null): string {
  if (!target) return '尚未選擇';
  return target.kind === 'self_managed' ? '改為自管' : target.name;
}

const money = (value: number) => `${value.toLocaleString('zh-TW')} 元`;
const shortHash = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-4)}`;

/** 六類項目的值轉成一行文字。缺項與不適用由呼叫端顯示。 */
export function formatSnapshotValue(categoryKey: string, item: SnapshotItem): string {
  const value = item.value as never;
  switch (`${categoryKey}.${item.key}`) {
    case 'title.lease_authority':
      return LEASE_AUTHORITY_LABELS[value] ?? String(value);
    case 'people.management_contract':
    case 'people.lease_contract':
      return `已簽 PDF，SHA-256 ${shortHash((value as { signedPdfSha256: string }).signedPdfSha256)}`;
    case 'condition.move_in':
      return (value as { name: string }).name;
    case 'condition.condition_attachments':
    case 'condition.equipment_attachments':
      return (value as { name: string }[]).map((a) => a.name).join('、');
    case 'money.deposit':
    case 'money.prepaid_rent':
    case 'money.uncollected_remittance':
      return money(value as number);
    case 'money.unpaid_periods': {
      const periods = value as { month: string; remaining: number }[];
      if (periods.length === 0) return '無';
      return periods.map((p) => `${p.month} 未足額 ${money(p.remaining)}`).join('、');
    }
    case 'admin.repairs': {
      const repairs = value as { title: string; status: string }[];
      const open = repairs.filter((r) => r.status !== 'done');
      if (open.length === 0) return '沒有未完成的修繕';
      return open.map((r) => `${r.title}（${REPAIR_STATUS_LABELS[r.status] ?? r.status}）`).join('、');
    }
    default:
      return String(value);
  }
}
