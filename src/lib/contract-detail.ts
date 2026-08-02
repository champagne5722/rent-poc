// 合約詳情頁（規格 §8）的判斷邏輯，全部是純函式。
// 頁面只負責取資料與畫畫面：哪個狀態出哪些操作、事件怎麼翻成中文、
// 文件列處在什麼狀態、衍生鏈怎麼排，都集中在這裡以便測試。
//
// 這支檔案會被 client component import，不能相依 node 專屬模組（fs、db 等）。

import dayjs from 'dayjs';
import type {
  Contract,
  ContractEvent,
  ContractFile,
  ContractFileKind,
  ContractRelations,
  ContractStatus,
} from './types';
import {
  CONTRACT_EVENT_ACTOR_LABELS,
  CONTRACT_EVENT_TYPE_LABELS,
  CONTRACT_FILE_KINDS,
  CONTRACT_FILE_LABELS,
} from './types';

// ── 頁首操作 ─────────────────────────────────────────────────

export type DetailActionKey = 'edit' | 'void' | 'signed_pdf' | 'audit_trail' | 'copy';

export interface DetailAction {
  key: DetailActionKey;
  label: string;
  /** 不可逆操作的確認文案；null 代表直接執行 */
  confirm: string | null;
}

const EDIT: DetailAction = { key: 'edit', label: '繼續編輯', confirm: null };
const VOID: DetailAction = {
  key: 'void',
  label: '撤回',
  confirm: '撤回後需複製為新草稿重新送簽，確定？',
};
const SIGNED_PDF: DetailAction = { key: 'signed_pdf', label: '下載已簽 PDF', confirm: null };
const AUDIT_TRAIL: DetailAction = { key: 'audit_trail', label: '下載 Audit Trail File', confirm: null };
const COPY: DetailAction = { key: 'copy', label: '複製為新草稿', confirm: null };

/**
 * 依狀態決定頁首操作（規格 §8）：
 * 草稿＝繼續編輯（進 wizard）、簽署中＝撤回、已完成＝下載兩份文件、已拒簽／已撤回＝複製為新草稿。
 */
export function detailActions(status: ContractStatus, opts: { mock: boolean }): DetailAction[] {
  switch (status) {
    case 'draft':
      return [EDIT];
    case 'awaiting_tenant':
    case 'awaiting_landlord':
      return [VOID];
    case 'completed':
      // mock 模式沒有真實簽署任務，點點簽端沒有 Audit Trail File 可下載
      return opts.mock ? [SIGNED_PDF] : [SIGNED_PDF, AUDIT_TRAIL];
    case 'declined':
    case 'voided':
      return [COPY];
  }
}

// ── 歷程事件 ─────────────────────────────────────────────────

// Timeline 圓點顏色：進行中藍、完成綠、拒簽紅、撤回橘、其餘灰
const EVENT_COLORS: Record<string, string> = {
  created: 'gray',
  sent: 'blue',
  tenant_signed: 'blue',
  declined: 'red',
  completed: 'green',
  voided: 'orange',
  copied: 'gray',
};

/** 事件型別→中文標籤；未知型別原樣回傳，避免舊資料讓整條歷程消失。 */
export function contractEventTypeLabel(type: string): string {
  return CONTRACT_EVENT_TYPE_LABELS[type as ContractEvent['type']] ?? type;
}

/** 行為者→中文標籤；未知值原樣回傳。 */
export function contractEventActorLabel(actor: string): string {
  return CONTRACT_EVENT_ACTOR_LABELS[actor as ContractEvent['actor']] ?? actor;
}

export function contractEventColor(type: string): string {
  return EVENT_COLORS[type] ?? 'gray';
}

export interface ContractEventEntry {
  key: number;
  label: string;
  actorLabel: string;
  time: string;
  note: string | null;
  color: string;
}

function formatEventTime(raw: string): string {
  const t = dayjs(raw);
  return t.isValid() ? t.format('YYYY-MM-DD HH:mm') : raw;
}

/** 事件序列→時間軸項目；順序照 API 回傳（append-only，已依發生順序）。 */
export function contractEventEntries(events: ContractEvent[]): ContractEventEntry[] {
  return events.map((e) => ({
    key: e.id,
    label: contractEventTypeLabel(e.type),
    actorLabel: contractEventActorLabel(e.actor),
    time: formatEventTime(e.created_at),
    note: e.note ?? null,
    color: contractEventColor(e.type),
  }));
}

// ── 文件分頁 ─────────────────────────────────────────────────

// saved＝已保存可下載；failed＝保存失敗可補抓；pending＝尚未產生；
// unavailable＝這個模式下不會有（mock 模式的 Audit Trail File）
export type ContractFileRowState = 'saved' | 'failed' | 'pending' | 'unavailable';

export interface ContractFileRow {
  kind: ContractFileKind;
  label: string;
  state: ContractFileRowState;
  hint: string;
  error: string | null;
  file: ContractFile | null;
  downloadHref: string;
}

const DOWNLOAD_PATHS: Record<ContractFileKind, string> = {
  signed_pdf: 'signed-pdf',
  audit_trail: 'audit-trail',
};

export function contractFileDownloadHref(contractId: number, kind: ContractFileKind): string {
  return `/api/contracts/${contractId}/${DOWNLOAD_PATHS[kind]}`;
}

const SAVED_HINTS: Record<ContractFileKind, string> = {
  signed_pdf: '合約完成簽署時自動保存',
  audit_trail: '受點點簽數位簽章保護，法律舉證以此為準（ADR-0007）',
};

/** 文件分頁的兩列（已簽 PDF、Audit Trail File）與各自狀態。 */
export function contractFileRows(
  contract: Contract,
  files: ContractFile[],
  opts: { mock: boolean }
): ContractFileRow[] {
  return CONTRACT_FILE_KINDS.map((kind) => {
    const label = CONTRACT_FILE_LABELS[kind];
    const file = files.find((f) => f.kind === kind) ?? null;
    const base = { kind, label, file, downloadHref: contractFileDownloadHref(contract.id, kind) };

    if (opts.mock && kind === 'audit_trail') {
      return {
        ...base,
        state: 'unavailable' as const,
        hint: `mock 模式沒有真實簽署任務，無法提供${label}`,
        error: null,
      };
    }
    if (file?.status === 'saved') {
      return { ...base, state: 'saved' as const, hint: SAVED_HINTS[kind], error: null };
    }
    if (file?.status === 'failed') {
      return { ...base, state: 'failed' as const, hint: '保存失敗，可手動補抓', error: file.error };
    }
    return {
      ...base,
      state: 'pending' as const,
      hint: contract.status === 'completed' ? '尚未保存，可手動補抓' : '合約完成簽署後產生',
      error: null,
    };
  });
}

// ── 關聯合約分頁 ─────────────────────────────────────────────

export type ContractChainRole = 'predecessor' | 'self' | 'successor';

export interface ContractChainNode {
  role: ContractChainRole;
  id: number;
  status: ContractStatus;
  note: string;
  /** 本約不連自己，其餘連到該合約詳情頁 */
  href: string | null;
}

const CHAIN_NOTES: Record<ContractChainRole, string> = {
  predecessor: '撤回後衍生出本約',
  self: '本約',
  successor: '本約撤回後衍生',
};

function chainNode(role: ContractChainRole, id: number, status: ContractStatus): ContractChainNode {
  return {
    role,
    id,
    status,
    note: CHAIN_NOTES[role],
    href: role === 'self' ? null : `/contracts/${id}`,
  };
}

/**
 * 衍生鏈：前身 → 本約 → 後繼（ADR-0006，只有撤回修約路徑會有關聯）。
 * 前後都沒有時回空陣列，UI 直接顯示 Empty。
 */
export function contractChainNodes(
  contract: Contract,
  relations: ContractRelations | null
): ContractChainNode[] {
  const predecessor = relations?.derived_from ?? null;
  const successors = relations?.derived_contracts ?? [];
  if (!predecessor && successors.length === 0) return [];

  const nodes: ContractChainNode[] = [];
  if (predecessor) nodes.push(chainNode('predecessor', predecessor.id, predecessor.status));
  nodes.push(chainNode('self', contract.id, contract.status));
  for (const s of successors) nodes.push(chainNode('successor', s.id, s.status));
  return nodes;
}
