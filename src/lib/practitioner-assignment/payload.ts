import type { Contract } from '@/lib/types';
import { getPracticeRegistry } from '@/lib/practice-registry';
import type { LeasingAuthoritySendFacts } from '@/lib/leasing-authority/preconditions';
import type { ContractRoutingLoad } from '@/lib/signature-routing/repository';
import type { MergedSeats } from '@/lib/signature-routing';
import { statusAnnexSendReasons } from '@/lib/status-annex/server';
import type { BrokerChoice } from './broker-choice';
import type { PractitionerAssignmentInput, PrintedPractitioner } from './seats';
import type { SendBlockReason, SendNotice } from '@/lib/send-preconditions';
import { evaluateSend, loadPrintedPractitioners, loadSeatOptions, type SeatOptions } from './service';

// 建約精靈的指派資料（MIL-69、MIL-200）：指派選項、目前的指派、簽署欄要印的人與送簽前檢查。
// GET /api/contracts/[id]/practitioners 與精靈頁的 server component 共用這一份，回應形狀一致。
// 登錄查詢在交易外（ADR-0012 決議 10），呼叫端先在交易內讀好合約、分流條件與指派再傳進來。

/** 同一人兼任而合併的席位（送簽前評估的 merges），附兼任者的姓名給畫面提示。 */
export type MergedSeatNotice = MergedSeats & { name: string };

export interface PractitionerPayload {
  options: SeatOptions;
  /** 居間選項的狀態，由伺服端依自家組織的經紀業別算出（MIL-200）。 */
  brokerChoice: BrokerChoice;
  assignments: PractitionerAssignmentInput[];
  printed: Record<string, PrintedPractitioner>;
  evaluation: { ok: boolean; reasons: SendBlockReason[]; notices: SendNotice[]; merges: MergedSeatNotice[] };
}

export interface PractitionerPayloadInput {
  contract: Contract;
  /** 已驗證通過的分流條件事實。 */
  routing: ContractRoutingLoad;
  assignments: PractitionerAssignmentInput[];
  leasingAuthority: LeasingAuthoritySendFacts | undefined;
  brokerChoice: BrokerChoice;
}

export async function buildPractitionerPayload({ contract, routing, assignments, leasingAuthority, brokerChoice }: PractitionerPayloadInput): Promise<PractitionerPayload> {
  if (!routing.ok) throw new Error('分流條件無效時沒有指派資料');
  const resolution = getPracticeRegistry();
  const at = new Date().toISOString();
  const [options, printed, evaluation, annexReasons] = await Promise.all([
    loadSeatOptions(routing.facts, resolution, at),
    loadPrintedPractitioners(routing.facts, assignments, resolution),
    evaluateSend({ routing: routing.facts, contractType: contract.contract_type, fields: contract.fields, assignments, at, leasingAuthority }, resolution),
    // 現況確認附件頁缺少執業人員的簽署區域（MIL-71）。確認頁併入原因清單，與送簽時的檢查一致
    statusAnnexSendReasons(contract),
  ]);
  return {
    options,
    brokerChoice,
    assignments,
    printed,
    evaluation: {
      ok: evaluation.ok && annexReasons.length === 0,
      reasons: [...evaluation.reasons, ...annexReasons],
      notices: evaluation.notices,
      // 同一人兼任而合併的席位，附上姓名給畫面提示（MIL-76）
      merges: evaluation.merges.map((m) => ({ ...m, name: printed[m.practitionerRuleId]?.name ?? '' })),
    },
  };
}
