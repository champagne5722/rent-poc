import type { ActionId } from '../access';
import { Forbidden } from '../authorize';
import { withCaseMemberTx, type CaseMemberTx } from '../case-store';
import { sha256Hex, parseObjectKey, type FileStore } from '../file-store';
import { withTx } from '../pg/database';
import type { RequestContext } from '../request-context';
import { findSignedPdf, readTenantCaseDetail, selectTenantCases } from './queries';
import type { SignedPdfResult, TenantCaseDetail, TenantCaseSummary } from './types';

// 承租人端的讀取入口（MIL-121）。呼叫者必須是 party 脈絡，/tenant 底下的 route 不接受組織脈絡（見 route.ts）。
// 案件拒絕一律丟 Forbidden（查不到成員、被 authorize() 拒絕），route 轉成與「案件不存在」相同的回應（P0-09 AC1）。

export type PartyRequestContext = Extract<RequestContext, { kind: 'party' }>;

/**
 * 承租人端只服務承租人與共同承租人。出租人、屋主等關係的 party 即使通過 authorize()，
 * 也不得從這裡讀（他們有自己的畫面）。拒絕與「不是成員」同一個錯誤，對外同一個回應。
 */
function requireTenantRelation(tx: CaseMemberTx, action: ActionId): void {
  if (!tx.relations.includes('lessee') && !tx.relations.includes('co_lessee')) {
    throw new Forbidden('not_a_member', action, { type: 'case', id: tx.caseId });
  }
}

/** 我的案件：這個 party 在所有組織的承租案件。靠成員讀取政策，不逐組織切換脈絡。 */
export async function listTenantCases(rc: PartyRequestContext): Promise<TenantCaseSummary[]> {
  return withTx({ kind: 'party', partyId: rc.partyId }, (tx) => selectTenantCases(tx, rc.partyId));
}

/** 案件詳情。不是成員、關係已結束、案件不存在，都丟 Forbidden。 */
export async function loadTenantCaseDetail(rc: PartyRequestContext, caseId: string): Promise<TenantCaseDetail> {
  return withCaseMemberTx(rc, { caseId, action: 'case.read_summary' }, (tx) => {
    requireTenantRelation(tx, 'case.read_summary');
    return readTenantCaseDetail(tx);
  });
}

/**
 * 下載已簽 PDF。成員資格與案件狀態由 withCaseMemberTx 檢查（動作 contract.download_signed，結案後仍可）。
 * 檔案經 FileStore 讀取，在交易外：交易內不得有 I/O（ADR-0012 決議 10）。
 * 檔案不在 FileStore，或內容與紀錄的 SHA-256 不符時回 not_available。讀取本身失敗（權限、網路）往外丟。
 */
export async function loadSignedPdf(rc: PartyRequestContext, caseId: string, files: FileStore): Promise<SignedPdfResult> {
  const found = await withCaseMemberTx(rc, { caseId, action: 'contract.download_signed' }, (tx) => {
    requireTenantRelation(tx, 'contract.download_signed');
    return findSignedPdf(tx);
  });
  if (found.kind === 'not_completed') return { ok: false, reason: 'not_completed' };
  if (found.kind === 'none') return { ok: false, reason: 'not_available' };
  const { record } = found;
  const bytes = await files.read(parseObjectKey(record.objectKey));
  if (!bytes) return { ok: false, reason: 'not_available' };
  if (sha256Hex(bytes) !== record.sha256) {
    console.error(`[tenant] ${record.objectKey} 的內容與紀錄的 SHA-256 不符，不提供下載`);
    return { ok: false, reason: 'not_available' };
  }
  return { ok: true, bytes, fileName: record.fileName, contentType: record.contentType };
}
