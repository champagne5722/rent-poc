// 合約送簽前的準備（MIL-69）：讀分流事實與指派，跑送簽前檢查，通過後組出簽署人並保存判定事實快照。
// route handler 與整合測試都走這裡，檢查的邏輯在 send-preconditions 與 service.ts。
//
// 分成三步，讓交易內只做資料庫讀寫（ADR-0012 決議 10）：
// 1. `loadSendInputs(tx, contractId)` 在交易內讀分流事實與指派。
// 2. `prepareContractSend(...)` 在交易外跑檢查。登錄（practiceRegistry）之後可能是外部查詢，不佔著連線。
// 3. `recordSendSnapshots(tx, ...)` 保存判定事實快照。

import type { PracticeRegistryResolution } from '../practice-registry';
import type { OrgTx } from '../pg/with-tx';
import type { SendBlockReason, SendNotice } from '../send-preconditions';
import { loadContractRoutingFacts, type ContractRoutingLoad } from '../signature-routing/repository';
import { prepareContractSigners } from '../signing';
import type { Signer } from '../signing-module/provider';
import type { Contract } from '../types';
import {
  getAssignments,
  saveCredentialSnapshots,
  type CredentialSnapshotInput,
  type PractitionerAssignment,
} from './repository';
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
      /** 判定事實快照。簽署任務建立成功時用 `recordSendSnapshots` 在同一個交易保存。 */
      snapshots: CredentialSnapshotInput[];
    }
  | { ok: false; status: 400; error: string; reasons: SendBlockReason[] };

/** 送簽前檢查要讀的資料，在同一個交易內取得。 */
export interface SendInputs {
  routing: ContractRoutingLoad;
  assignments: PractitionerAssignment[];
}

export async function loadSendInputs(tx: OrgTx, contractId: string): Promise<SendInputs> {
  return {
    routing: await loadContractRoutingFacts(tx, contractId),
    assignments: await getAssignments(tx, contractId),
  };
}

/**
 * @param at 判定時點，ISO 8601。送簽當下由呼叫端傳入，不在這裡讀系統時間。
 */
export async function prepareContractSend(
  contract: Contract,
  inputs: SendInputs,
  resolution: PracticeRegistryResolution,
  at: string,
): Promise<PreparedContractSend> {
  const { routing, assignments } = inputs;
  if (!routing.ok) return { ok: false, status: 400, error: routing.reason, reasons: [] };

  const evaluation = await evaluateSend(
    { routing: routing.facts, fields: contract.fields, assignments, at },
    resolution,
  );
  if (!evaluation.ok) {
    const messages = evaluation.reasons.map((r) => r.message);
    return { ok: false, status: 400, error: `無法送簽：${messages.join('。')}`, reasons: evaluation.reasons };
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
 * 保存判定事實快照。簽署任務建立成功時與簽署任務同一個交易寫入：建立失敗時不留快照，重複送簽時覆蓋。
 * 簽章紀錄（MIL-70）之後改成與簽署進度同交易的 `snapshot_at_send`。
 */
export async function recordSendSnapshots(
  tx: OrgTx,
  contractId: string,
  prepared: Extract<PreparedContractSend, { ok: true }>,
): Promise<void> {
  await saveCredentialSnapshots(tx, contractId, prepared.snapshots);
}
