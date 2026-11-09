// 現況確認附件頁的簽署區域檢查（MIL-71、ADR-0018 決議 6）。純函式，沒有 I/O。
//
// 規則列的 `requiredFieldPages` 含 `status_annex` 的席位，必須在附件頁至少有一個簽署區域。
// 只檢查規則列指定的席位：包租租賃合約是專任管理人員，居間的經紀人席位與甲乙方不必在附件頁簽署。
// 同一人兼任（MIL-76）時，兩個席位的簽署區域都歸合併後的簽署人，要求的席位不變。
//
// 這項檢查要知道附件頁的頁碼，頁碼由產生 PDF 的函式回報（PdfPageMap），所以不併入 checkSendPreconditions 的七項。
// 呼叫端（送簽流程、確認頁的預檢）把結果併入送簽前的原因清單。

import type { PdfPageMap } from '../pdf-layout';
import { practitionerTitle } from '../labels';
import { missingStatusAnnexSeats, routeSignatures, type RoutingFacts } from '../signature-routing';
import { SIGNER_ROLE_LABELS, type SignatureField } from '../types';
import { statusAnnexSignatureMissingMessage } from '../status-annex';
import type { SendBlockReason } from './check';

export function checkStatusAnnexSignatureFields(
  routing: RoutingFacts,
  signatureFields: readonly SignatureField[],
  pages: Pick<PdfPageMap, 'statusAnnexPage'>,
): SendBlockReason[] {
  const route = routeSignatures(routing);
  if (route.kind !== 'sequence') return [];
  return missingStatusAnnexSeats(route.plan, signatureFields, pages.statusAnnexPage).map((seat) => {
    const kind = seat.practitioner?.certificateKinds[0];
    const label = kind ? `${SIGNER_ROLE_LABELS[seat.role]}（${practitionerTitle(kind)}）` : SIGNER_ROLE_LABELS[seat.role];
    return {
      code: 'status_annex_signature_missing' as const,
      message: statusAnnexSignatureMissingMessage(label),
      seatRuleId: seat.ruleId,
    };
  });
}
