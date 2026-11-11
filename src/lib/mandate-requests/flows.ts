import { appendAudit } from '../audit';
import { parseObjectKey, sha256Hex, type FileStore } from '../file-store';
import { recordTranscriptConsent } from '../ownership/repository';
import { submitTranscriptFlow } from '../ownership';
import { withTx } from '../pg/database';
import { AnchorKeyRejectedError, registerProperty } from '../properties';
import { draftToPropertyInput } from './draft';
import { getOwnerRow, getOwnerTranscript, recordDraftConfirmed } from './owner-repository';
import { effectiveStatus } from './status';
import { factsOf } from './repository';

// 屋主確認業者代填資料的流程（MIL-206 驗收 9、10）。route 只負責認證、授權與解析請求。
// 順序的原則：交易內不做外部 I/O（ADR-0012 決議 10）。
// 1. 屋主組織的交易：重新驗證代填資料，走既有的 registerProperty 登錄在屋主的組織（回應與一般登錄相同，
//    撞到別的組織的建號時也一樣，ADR-0028 決議 1、2），記錄確認，記錄個資告知的同意或反對，寫稽核事件。
// 2. 交易提交後，屋主同意個資告知而且業者有代傳謄本時，讀出檔案，呼叫既有的送件路徑 submitTranscriptFlow，
//    轉成屋主組織自己的謄本送核對。這一步不改 registry.submit_ownership_transcript。屋主不同意時，謄本不轉。
// 業者代傳的原檔留在原處，直到屋主送出、收回或連結失效才刪（migration 0086 的函式負責清資料，route 負責刪檔）。

export type TranscriptOutcome =
  /** 已轉成屋主組織的謄本，送平台核對。 */
  | 'forwarded'
  /** 屋主同意，但這次沒有轉成：檔案讀不到、物件已在核對中或已核對、謄本表單不合格等。 */
  | 'not_forwarded'
  /** 屋主不同意個資告知，謄本不轉。申請仍能送出，核對時要屋主自己補件。 */
  | 'declined'
  /** 業者沒有代傳謄本。 */
  | 'none';

export type ConfirmFlowResult =
  | { status: 'confirmed'; propertyId: string; rentalUnitId: string; existing: boolean; transcript: TranscriptOutcome }
  | { status: 'already_confirmed'; rentalUnitId: string | null }
  | { status: 'not_found' | 'expired' | 'not_pending' | 'no_draft' }
  | { status: 'draft_invalid'; message: string };

export interface OwnerFlowDeps {
  store: FileStore;
  now: Date;
}

export interface OwnerActor {
  orgId: string;
  partyId: string;
}

/** 資料庫在確認的當下已不是待確認（並發的請求）：讓交易回滾，回傳對應結果。 */
class Rollback extends Error {
  constructor(readonly result: ConfirmFlowResult) {
    super('rollback');
  }
}

export async function confirmDraftFlow(
  actor: OwnerActor,
  requestId: string,
  consent: 'agree' | 'decline',
  deps: OwnerFlowDeps,
): Promise<ConfirmFlowResult> {
  const ctx = { kind: 'org', orgId: actor.orgId, partyId: actor.partyId } as const;
  let registered: { propertyId: string; rentalUnitId: string; existing: boolean; transcript: Awaited<ReturnType<typeof getOwnerTranscript>> };
  try {
    const early = await withTx(ctx, async (tx): Promise<ConfirmFlowResult | { done: typeof registered }> => {
      const row = await getOwnerRow(tx, requestId, deps.now);
      if (!row) return { status: 'not_found' };
      if (effectiveStatus(factsOf(row), deps.now) === 'expired') return { status: 'expired' };
      if (row.status !== 'pending_owner') return { status: 'not_pending' };
      if (row.draft === null) return { status: 'no_draft' };
      if (row.confirmed_unit_id !== null) return { status: 'already_confirmed', rentalUnitId: row.confirmed_unit_id };

      // 存放的值不信任，重新驗證。格式不合格是業者端的問題，屋主看到固定訊息
      const parsed = draftToPropertyInput(row.draft);
      if (!parsed.ok) return { status: 'draft_invalid', message: parsed.error };

      const property = await registerProperty(tx, parsed.input);
      const unit = await tx.query<{ rental_unit_id: string }>('SELECT rental_unit_id FROM org.properties WHERE id = $1', [property.id]);
      const rentalUnitId = unit.rows[0].rental_unit_id;
      const recorded = await recordDraftConfirmed(tx, requestId, rentalUnitId, deps.now);
      if (recorded.outcome !== 'confirmed') {
        const result: ConfirmFlowResult =
          recorded.outcome === 'already_confirmed'
            ? { status: 'already_confirmed', rentalUnitId: recorded.unitId }
            : { status: recorded.outcome === 'unit_not_found' ? 'not_found' : recorded.outcome };
        throw new Rollback(result);
      }
      await recordTranscriptConsent(tx, property.id, actor.partyId, consent === 'agree' ? 'agree' : 'object');
      const transcript = consent === 'agree' ? await getOwnerTranscript(tx, requestId, deps.now) : null;
      await appendAudit(tx, {
        action: 'request.confirm_draft',
        object: { type: 'mandate_request', id: requestId },
        payload: { rental_unit_id: rentalUnitId, existing: property.kind === 'existing', consent },
      });
      return { done: { propertyId: property.id, rentalUnitId, existing: property.kind === 'existing', transcript } };
    });
    if (!('done' in early)) return early;
    registered = early.done;
  } catch (error) {
    if (error instanceof Rollback) return error.result;
    if (error instanceof AnchorKeyRejectedError) return { status: 'draft_invalid', message: error.message };
    throw error;
  }

  return {
    status: 'confirmed',
    propertyId: registered.propertyId,
    rentalUnitId: registered.rentalUnitId,
    existing: registered.existing,
    transcript: await forwardTranscript(actor, registered, consent, deps),
  };
}

async function forwardTranscript(
  actor: OwnerActor,
  registered: { propertyId: string; transcript: Awaited<ReturnType<typeof getOwnerTranscript>> },
  consent: 'agree' | 'decline',
  deps: OwnerFlowDeps,
): Promise<TranscriptOutcome> {
  if (consent === 'decline') return 'declined';
  const stored = registered.transcript;
  if (!stored) return 'none';
  const bytes = await deps.store.read(parseObjectKey(stored.objectKey));
  if (!bytes || sha256Hex(bytes) !== stored.sha256) return 'not_forwarded';
  const form = stored.form;
  const result = await submitTranscriptFlow(
    actor,
    registered.propertyId,
    {
      claimedOwner: form.claimed_owner,
      acquiredAt: form.acquired_at,
      hasTrust: form.has_trust,
      trustRegisteredOwner: form.trust_registered_owner,
      trustRelatedParties: form.trust_related_parties,
      trustRegistrationStatus: form.trust_registration_status,
      trustLeaseClause: form.trust_lease_clause,
    },
    { fileName: stored.fileName, contentType: stored.contentType, bytes },
    { store: deps.store, now: () => deps.now },
  );
  return result.status === 'submitted' ? 'forwarded' : 'not_forwarded';
}
