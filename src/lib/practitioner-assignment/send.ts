// 合約送簽前的準備（MIL-69）：讀分流事實與指派，跑送簽前檢查，通過後組出簽署人並保存判定事實快照。
// route handler 與整合測試都走這裡，檢查的邏輯在 send-preconditions 與 service.ts。

import type Database from 'better-sqlite3';
import { getDb } from '../db';
import type { PracticeRegistryResolution } from '../practice-registry';
import type { SendBlockReason, SendNotice } from '../send-preconditions';
import { templateReviewBlock } from '../template-review';
import { loadContractRoutingFacts } from '../signature-routing/repository';
import { prepareContractSigners } from '../signing';
import type { Signer } from '../signing-module/provider';
import type { Contract } from '../types';
import { getAssignments, saveCredentialSnapshots, type CredentialSnapshotInput } from './repository';
import type { PrintedPractitioner } from './seats';
import { evaluateSend } from './service';

export type PreparedContractSend =
  | {
      ok: true;
      signers: Signer[];
      /** 草稿 PDF 與送簽 PDF 的簽署欄資料。 */
      printed: Record<string, PrintedPractitioner>;
      /** 換證窗口內的提醒。仍得送簽，畫面顯示期限。 */
      notices: SendNotice[];
      /** 判定事實快照。簽署任務建立成功後用 `recordSendSnapshots` 保存。 */
      snapshots: CredentialSnapshotInput[];
    }
  | { ok: false; status: 400; error: string; reasons: SendBlockReason[] };

/**
 * @param at 判定時點，ISO 8601。送簽當下由呼叫端傳入，不在這裡讀系統時間。
 */
export async function prepareContractSend(
  contract: Contract,
  resolution: PracticeRegistryResolution,
  at: string,
  db: Database.Database = getDb(),
): Promise<PreparedContractSend> {
  const routing = await loadContractRoutingFacts(contract.id, db);
  if (!routing.ok) return { ok: false, status: 400, error: routing.reason, reasons: [] };

  const assignments = await getAssignments(contract.id, db);
  const evaluation = await evaluateSend(
    { routing: routing.facts, contractType: contract.contract_type, fields: contract.fields, assignments, at },
    resolution,
  );
  // 未審閱範本的閘門（P0-10 AC5）：正式金鑰下擋下，與送簽前檢查的原因一起列出
  const templateBlock = templateReviewBlock(contract.contract_type, contract.fields, process.env);
  if (!evaluation.ok || templateBlock) {
    const reasons: SendBlockReason[] = [...(evaluation.ok ? [] : evaluation.reasons), ...(templateBlock ? [templateBlock] : [])];
    return { ok: false, status: 400, error: `無法送簽：${reasons.map((r) => r.message).join('。')}`, reasons };
  }

  const prepared = prepareContractSigners(contract, routing.facts, evaluation.assignees);
  if (!prepared.ok) return { ok: false, status: prepared.status, error: prepared.error, reasons: [] };

  return {
    ok: true,
    signers: prepared.signers,
    printed: evaluation.printed,
    notices: evaluation.notices,
    snapshots: evaluation.snapshots,
  };
}

/**
 * 簽署任務建立成功後保存判定事實快照，送簽失敗時不留快照。重複送簽時覆蓋。
 * 簽章紀錄（MIL-70）之後改成與簽署進度同交易的 `snapshot_at_send`。
 */
export async function recordSendSnapshots(
  contractId: number,
  prepared: Extract<PreparedContractSend, { ok: true }>,
  db: Database.Database = getDb(),
): Promise<void> {
  await saveCredentialSnapshots(contractId, prepared.snapshots, db);
}
