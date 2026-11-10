import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { caseIdOf, caseNotFound, type CaseRouteCtx } from '@/lib/case-store/route';
import { requestContext } from '@/lib/current-request-context';
import { buildObjectKey, getFileStore, sha256Hex } from '@/lib/file-store';
import { jsonError, jsonOk, readJson } from '@/lib/http';
import { DEPOSIT_HOLDER_MESSAGE_TEXT } from '@/lib/labels/case-ledger-labels';
import {
  confirmReceipt,
  type ConfirmReceiptFailure,
  type ConfirmReceiptResult,
  type HolderRuleNotice,
  type ReceiptEvidence,
} from '@/lib/ledger/receipts';
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_TYPES,
  parseReceiptRequest,
  safeEvidenceName,
  sniffEvidenceType,
} from '@/lib/ledger/receipt-request';
import { dispatchNotificationEmail } from '@/lib/notifications';
import { authorizeOnly, inOrgTxAs } from '@/lib/org-route';
import { newUlid } from '@/lib/pg/ulid';

// 手動登錄入帳確認（MIL-125，ADR-0014 決議 2、4、7、13、15）。權限是 ledger.record_payment：
// 自管與包租案件的主辦組織 admin、staff。代管案件要等委託事實載入（MIL-116、MIL-119）才放行，現在一律拒絕。
// 別的組織的案件成員（例如被加為出租人的屋主）通過動作表也不放行：交易的組織脈絡不是案件的組織。
// 同步完成：入帳確認、分錄、配置、持有人確認紀錄、通知、稽核事件在一個交易內提交，不經 worker。
//
// 請求可以是 JSON，也可以是 multipart/form-data（附證明檔）。證明檔選填，大小上限 5 MB，只收 PDF、JPEG、PNG。
// 檔案寫進 FileStore 在交易外，所以先過一次權限，再寫檔，再開交易。
// 入帳失敗或是重送時，剛寫的檔案刪掉，不留孤兒檔。
//
// 回應：成功 201（重送同一個冪等鍵回 200 與原本那筆）。
// 押金帳戶規則 block 回 422，warn 尚未確認回 409，兩者都帶 notice 給畫面顯示警告與範本依據。

const noticeBody = (failure: Extract<ConfirmReceiptFailure, { notice: HolderRuleNotice }>) => ({
  ...failure.notice,
  text: failure.notice.messageKey ? (DEPOSIT_HOLDER_MESSAGE_TEXT[failure.notice.messageKey] ?? '') : '',
});

function failureResponse(failure: ConfirmReceiptFailure): Response {
  switch (failure.code) {
    case 'invalid_input':
      return jsonError(400, failure.message);
    case 'case_not_found':
      return caseNotFound();
    case 'ledger_not_open':
      return jsonError(409, '合約尚未全員簽署完成，還不能登錄入帳', 'ledger_not_open');
    case 'deposit_settled':
      return jsonError(409, '押金台帳已結清，不能再登錄押金', 'deposit_settled');
    case 'account_not_usable':
      return jsonError(422, '收款帳戶不存在或已停用', 'account_not_usable');
    case 'holder_blocked':
      return jsonOk({ error: '這個收款帳戶不能收取這個案件的押金', code: 'holder_blocked', notice: noticeBody(failure) }, { status: 422 });
    case 'holder_ack_required':
      return jsonOk({ error: '押金的收款帳戶持有人需要先確認', code: 'holder_ack_required', notice: noticeBody(failure) }, { status: 409 });
    case 'idempotency_conflict':
      return jsonError(409, '這張表單已經送出過內容不同的入帳，請重新整理頁面再登錄', 'idempotency_conflict');
    case 'ledger_rejected':
      // 純函式層的檢查沒過代表程式有誤，不是使用者能處理的錯誤
      throw new Error(`鏡像帳拒絕入帳：${failure.errors.map((e) => e.code).join(',')}`);
  }
}

function successBody(result: Extract<ConfirmReceiptResult, { ok: true }>) {
  return {
    data: {
      duplicate: result.duplicate,
      confirmation: result.confirmation,
      allocations: result.allocations,
      prepaid: result.prepaid,
      holderAcknowledgmentId: result.holderAcknowledgmentId,
      // 同一份證明檔已用在另一筆入帳確認：畫面顯示警告，不阻擋（ADR-0014 決議 7）
      evidenceReused: result.confirmation.evidenceReuseOf !== null,
    },
  };
}

/** 讀請求。multipart 的值都是字串，檔案另外取出。 */
async function readBody(request: NextRequest): Promise<{ fields: unknown; file: File | null } | { error: Response }> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) {
    return { fields: await readJson(request), file: null };
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { error: jsonError(400, '無法讀取上傳的表單') };
  }
  const fields: Record<string, unknown> = {};
  let file: File | null = null;
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') fields[key] = value;
    else if (key === 'evidence' && value.size > 0) file = value;
  }
  return { fields, file };
}

export async function POST(request: NextRequest, { params }: CaseRouteCtx) {
  const id = await caseIdOf(params);
  if (!id) return caseNotFound();

  const body = await readBody(request);
  if ('error' in body) return body.error;
  const parsed = parseReceiptRequest(body.fields);
  if (!parsed.ok) return jsonError(400, parsed.error);

  let bytes: Uint8Array | null = null;
  let contentType: keyof typeof EVIDENCE_TYPES | null = null;
  if (body.file) {
    if (body.file.size > EVIDENCE_MAX_BYTES) return jsonError(413, '證明檔不得超過 5 MB');
    bytes = new Uint8Array(await body.file.arrayBuffer());
    contentType = sniffEvidenceType(bytes);
    if (!contentType) return jsonError(400, '證明檔只收 PDF、JPEG 與 PNG');
  }

  // 寫檔在交易外，所以先過一次權限。沒有權限就不寫檔
  const denied = await authorizeOnly('ledger.record_payment', { type: 'case', id });
  if (denied) return denied;

  let evidence: ReceiptEvidence | null = null;
  let storedKey: ReturnType<typeof buildObjectKey> | null = null;
  if (bytes && contentType && body.file) {
    const rc = await requestContext();
    if (rc.kind !== 'org') return jsonError(403, '請以組織身分操作');
    storedKey = buildObjectKey(rc.orgId, 'ledger', 'receipt-evidence', `${newUlid()}.${EVIDENCE_TYPES[contentType]}`);
    await getFileStore('general').write(storedKey, bytes, { contentType });
    evidence = {
      objectKey: storedKey,
      sha256: sha256Hex(bytes),
      fileName: safeEvidenceName(body.file.name, `匯款證明.${EVIDENCE_TYPES[contentType]}`),
      contentType,
    };
  }

  let orgId = '';
  // 閉包內賦值，用物件承接，TypeScript 才不會把外層變數窄化成 null
  const outcome: { result: ConfirmReceiptResult | null } = { result: null };
  let response: Response;
  try {
    response = await inOrgTxAs(async (tx, rc) => {
      const grant = await authorize(tx, 'ledger.record_payment', { type: 'case', id });
      // 入帳寫進案件所在的組織。以案件成員身分（別的組織）通過權限的人，這個交易的組織脈絡不是案件的組織，
      // 寫不進去，所以在這裡擋下，回應與沒有權限相同。成員身分的寫入入口是 withCaseMemberTx，等有需求再接
      if (grant.via !== 'host_org') return caseNotFound();
      orgId = rc.orgId;
      const result = await confirmReceipt(tx, {
        source: 'manual',
        externalId: parsed.value.idempotencyKey,
        caseId: id,
        purpose: parsed.value.purpose,
        amount: parsed.value.amount,
        valueDate: parsed.value.valueDate,
        paymentAccountId: parsed.value.paymentAccountId,
        recordedByPartyId: rc.partyId,
        onBehalf: grant.onBehalf,
        evidence,
        acknowledgeHolderWarning: parsed.value.acknowledgeHolderWarning,
      });
      outcome.result = result;
      if (!result.ok) return failureResponse(result.failure);
      return jsonOk(successBody(result), { status: result.duplicate ? 200 : 201 });
    });
  } catch (error) {
    await discardEvidence(storedKey);
    throw error;
  }

  const done = outcome.result;
  // 失敗、重送時，剛寫的檔案不會被任何入帳確認引用，刪掉
  if (storedKey && (!done || !done.ok || done.duplicate)) await discardEvidence(storedKey);
  if (done?.ok) {
    for (const notice of done.notices) {
      try {
        await dispatchNotificationEmail(orgId, notice.outboxId);
      } catch (error) {
        // 入帳已提交。派送失敗的列留在 outbox，由排程重試
        console.error('[receipts] 通知 email 派送失敗', error);
      }
    }
  }
  return response;
}

async function discardEvidence(key: ReturnType<typeof buildObjectKey> | null): Promise<void> {
  if (!key) return;
  try {
    await getFileStore('general').delete(key);
  } catch (error) {
    console.error('[receipts] 刪除未使用的證明檔失敗', error);
  }
}
