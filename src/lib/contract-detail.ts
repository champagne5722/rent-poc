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
  EquipmentAnnexSnapshot,
} from './types';
import {
  CONTRACT_EVENT_ACTOR_LABELS,
  CONTRACT_EVENT_TYPE_LABELS,
  CONTRACT_FILE_KINDS,
  CONTRACT_FILE_LABELS,
  REPAIR_RESPONSIBILITY_LABELS,
  SIGNER_ROLE_LABELS,
} from './types';
import { contractEquipmentAnnex, formatEquipmentItem } from './equipment';
import type { ContractType } from './labels';
import {
  buildSigningSteps,
  signerRoleOfStatus,
  signingStepStateLabel,
  stepsShowSignerDetail,
  type SigningProgressInput,
  type SigningSeat,
  type SigningSteps,
} from './signing-steps';
import type { CurrentSigner } from './signing-module/provider';
import type { SigningProgress } from './signing-module/sign-task-store';

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
    case 'awaiting_practitioner':
      return [VOID];
    case 'completed':
      // mock 模式沒有真實簽署任務，點點簽端沒有 Audit Trail File 可下載
      return opts.mock ? [SIGNED_PDF] : [SIGNED_PDF, AUDIT_TRAIL];
    case 'declined':
    case 'voided':
      return [COPY];
  }
}

// ── 簽署狀態列 ───────────────────────────────────────────────

/**
 * 目前待簽：只讀簽署進度的當前簽署人（ADR-0010），不由合約狀態推導。
 * 沒有簽署進度的合約（送簽時沒有留下任務編號的舊資料）不顯示目前待簽，
 * 因為簽署連結與重寄都要靠簽署任務才能執行。
 */
export function detailCurrentSigner(
  progress: Pick<SigningProgress, 'currentSigner'> | null
): CurrentSigner | null {
  return progress?.currentSigner ?? null;
}

export interface DetailSigningSteps {
  titles: string[];
  current: number;
}

/**
 * 狀態列的簽署步驟，每位簽署人一步，最後是「完成」。步驟由實際的簽署序列推導（MIL-72）：
 * 有簽署進度時，順序與人數由簽署人決定，兼任的簽署人標示兼任角色。
 * 沒有簽署進度（舊資料）時用規則表算出的序列（seats），再沒有就退回兩方。
 * 稱謂依合約類型從標籤對照表取（MIL-122）。
 */
export function detailSigningSteps(
  status: ContractStatus,
  progress?: SigningProgressInput | null,
  contractType: ContractType = 'lease',
  seats?: readonly SigningSeat[] | null
): DetailSigningSteps {
  const { steps, position } = buildSigningSteps({ status, progress, seats, contractType });
  const titles = [...steps.map((step) => `待${step.fullLabel}簽署`), '完成'];
  return { titles, current: Math.min(position ?? 0, titles.length - 1) };
}

/**
 * 每一步下方的簽署人姓名與狀態。兩方合約不列，畫面維持原樣；
 * 三位以上或有兼任時列出每位簽署人的姓名與狀態，最後的「完成」沒有說明。
 */
export function detailStepDescriptions(result: SigningSteps): Array<string | undefined> {
  if (!stepsShowSignerDetail(result)) return [];
  return [
    ...result.steps.map((step) => `${step.name ?? '（尚未指定）'}・${signingStepStateLabel(step.state)}`),
    undefined,
  ];
}

export interface MockAdvanceAction {
  event: 'signed' | 'completed' | 'declined';
  label: string;
  /** 操作成功後顯示的訊息 */
  message: string;
  danger?: boolean;
}

/**
 * mock 模式的模擬 webhook 按鈕，依當前簽署人決定。
 * 當前簽署人是最後一位時，簽署就是合約完成，事件用 completed；否則用 signed。
 * 沒有簽署進度時（舊資料）依合約狀態：甲方視為最後一位，與兩方合約的原本行為相同。
 */
export function mockAdvanceActions(
  status: ContractStatus,
  progress: Pick<SigningProgress, 'signers'> | null
): MockAdvanceAction[] {
  const role = signerRoleOfStatus(status);
  if (!role) return [];
  const label = SIGNER_ROLE_LABELS[role];
  const pendingCount = progress ? progress.signers.filter((s) => s.status === 'pending').length : null;
  const isLast = pendingCount === null ? role === 'party_a' : pendingCount <= 1;
  const sign: MockAdvanceAction = isLast
    ? { event: 'completed', label: `模擬${label}簽署完成`, message: `已模擬${label}簽署，合約完成` }
    : { event: 'signed', label: `模擬${label}簽署`, message: `已模擬${label}簽署` };
  // 最後一位甲方原本沒有拒簽按鈕，維持不變
  if (isLast && role === 'party_a') return [sign];
  return [sign, { event: 'declined', label: `模擬${label}拒簽`, message: `已模擬${label}拒簽`, danger: true }];
}

/**
 * 已拒簽合約的提示標題：寫出拒簽的簽署人角色。
 * 舊合約沒有簽署進度，兩方合約只有乙方會拒簽（甲方後簽，乙方拒簽即結束），維持原文案。
 */
export function detailDeclinedTitle(progress: Pick<SigningProgress, 'signers'> | null): string {
  const role = progress?.signers.find((s) => s.status === 'declined')?.role ?? 'party_b';
  return `${SIGNER_ROLE_LABELS[role]}已拒簽`;
}

// ── 歷程事件 ─────────────────────────────────────────────────

// Timeline 圓點顏色：進行中藍、完成綠、拒簽紅、撤回橘、其餘灰
const EVENT_COLORS: Record<string, string> = {
  created: 'gray',
  sent: 'blue',
  tenant_signed: 'blue',
  signer_signed: 'blue',
  declined: 'red',
  completed: 'green',
  voided: 'orange',
  copied: 'gray',
  credential_lapsed: 'red',
  auto_void_failed: 'red',
  signers_merged: 'gray',
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

// ── 設備附件摘要 ─────────────────────────────────────────────

/**
 * 詳情頁「合約摘要」的設備附件列，一列一行：「冷氣 ×2｜修繕：出租方｜備註」。
 * 讀的是合約自己的快照，舊合約的字串設備欄位由 contractEquipmentAnnex 轉出來（MIL-29）。
 */
export function equipmentAnnexSummary(fields: EquipmentAnnexSnapshot): string[] {
  return contractEquipmentAnnex(fields).map((row) => {
    const parts = [formatEquipmentItem(row), `修繕：${REPAIR_RESPONSIBILITY_LABELS[row.repair]}`];
    if (row.note.trim()) parts.push(row.note.trim());
    return parts.join('｜');
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
