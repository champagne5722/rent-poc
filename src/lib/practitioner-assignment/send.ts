// 合約送簽前的準備（MIL-69）：讀分流事實與指派，跑送簽前檢查，通過後組出簽署人並保存判定事實快照。
// route handler 與整合測試都走這裡，檢查的邏輯在 send-preconditions 與 service.ts。

import type Database from 'better-sqlite3';
import { getDb } from '../db';
import type { PracticeRegistryResolution } from '../practice-registry';
import type { SendBlockReason, SendNotice } from '../send-preconditions';
import { loadContractRoutingFacts } from '../signature-routing/repository';
import { prepareContractSigners } from '../signing';
import type { Signer } from '../signing-module/provider';
import type { Contract } from '../types';
import type { ContractSendContext } from '../signature-records/types';
import { getAssignments } from './repository';
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
      /**
       * 簽章紀錄的送簽資料。呼叫 `signing.send` 時當第四個參數，合約訂閱者在送簽交易內寫入（MIL-70）。
       * 沒有執業人員席位時不帶。
       */
      sendContext?: ContractSendContext;
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
    ...(evaluation.records.length > 0 ? { sendContext: { kind: 'contract_send' as const, records: evaluation.records } } : {}),
  };
}
