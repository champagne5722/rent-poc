// 合約送簽前的準備（MIL-69）：讀分流事實與指派，跑送簽前檢查，通過後組出簽署人與簽章紀錄的送簽資料（MIL-70）。
// route handler 與整合測試都走這裡，檢查的邏輯在 send-preconditions 與 service.ts。
//
// 分成兩步，讓交易內只做資料庫讀寫（ADR-0012 決議 10）：
// 1. `loadSendInputs(tx, contractId)` 在交易內讀分流事實與指派。
// 2. `prepareContractSend(...)` 在交易外跑檢查。登錄（practiceRegistry）之後可能是外部查詢，不佔著連線。
// 簽章紀錄（MIL-70）由合約訂閱者的 `onSent` 在送簽交易內寫入，資料走 `signing.send` 的 `context`。

import type { PdfPageMap } from '../pdf-layout';
import type { PracticeRegistryResolution } from '../practice-registry';
import type { OrgTx } from '../pg/with-tx';
import { checkStatusAnnexSignatureFields, type SendBlockReason, type SendNotice } from '../send-preconditions';
import { templateReviewBlock } from '../template-review';
import { loadContractRoutingFacts, type ContractRoutingLoad } from '../signature-routing/repository';
import { prepareContractSigners } from '../signing';
import type { Signer } from '../signing-module/provider';
import type { Contract } from '../types';
import type { ContractSendContext } from '../signature-records/types';
import { getAssignments, type PractitionerAssignment } from './repository';
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
       * 簽章紀錄的送簽資料。呼叫 `signing.send` 時放進第四個參數的 `context`，合約訂閱者在送簽交易內寫入（MIL-70）。
       * 沒有執業人員席位時不帶。
       */
      sendContext?: ContractSendContext;
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

export interface PrepareContractSendOptions {
  /**
   * PDF 的頁面地圖（statusAnnexPageMap 算出）。有帶時檢查規則列要求的現況確認附件頁簽署區域（MIL-71），
   * 缺少時原因併入原因清單。沒有帶時不檢查這一項：只有呼叫端知道附件頁在哪一頁，送簽 route 一律要帶。
   */
  pages?: PdfPageMap;
}

/**
 * @param at 判定時點，ISO 8601。送簽當下由呼叫端傳入，不在這裡讀系統時間。
 */
export async function prepareContractSend(
  contract: Contract,
  inputs: SendInputs,
  resolution: PracticeRegistryResolution,
  at: string,
  options: PrepareContractSendOptions = {},
): Promise<PreparedContractSend> {
  const { routing, assignments } = inputs;
  if (!routing.ok) return { ok: false, status: 400, error: routing.reason, reasons: [] };

  const evaluation = await evaluateSend(
    { routing: routing.facts, contractType: contract.contract_type, fields: contract.fields, assignments, at },
    resolution,
  );
  // 未審閱範本的閘門（P0-10 AC5）：正式金鑰下擋下，與送簽前檢查的原因一起列出
  const templateBlock = templateReviewBlock(contract.contract_type, contract.fields, process.env);
  // 現況確認附件頁的簽署區域（MIL-71）：規則列要求的席位在附件頁沒有簽名框時擋下
  const annexReasons = options.pages
    ? checkStatusAnnexSignatureFields(routing.facts, contract.signature_fields, options.pages)
    : [];
  if (!evaluation.ok || templateBlock || annexReasons.length > 0) {
    const reasons: SendBlockReason[] = [
      ...(evaluation.ok ? [] : evaluation.reasons),
      ...(templateBlock ? [templateBlock] : []),
      ...annexReasons,
    ];
    return { ok: false, status: 400, error: `無法送簽：${reasons.map((r) => r.message).join('。')}`, reasons };
  }

  const prepared = prepareContractSigners(contract, routing.facts, evaluation.assignees, evaluation.identities);
  if (!prepared.ok) return { ok: false, status: prepared.status, error: prepared.error, reasons: [] };

  return {
    ok: true,
    signers: prepared.signers,
    printed: evaluation.printed,
    notices: evaluation.notices,
    ...(evaluation.records.length > 0 ? { sendContext: { kind: 'contract_send' as const, records: evaluation.records } } : {}),
  };
}
