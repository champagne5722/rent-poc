import { appendContractEvent, getContract, getDb } from './db';
import { getPracticeRegistry, type PracticeRegistryResolution } from './practice-registry';
import { completeSignSnapshot, insertSignatureRecords, listPendingSignRecords } from './signature-records/repository';
import {
  buildCredentialSnapshot,
  isUnavailableSnapshot,
  unavailableSnapshot,
  type SignatureSnapshot,
} from './signature-records/snapshot';
import { hasVoidPendingLapse, markVoidFailed, recordLapse, settleOpenLapses } from './signing-lapse/repository';
import { isContractSendContext } from './signature-records/types';
import type { ProgressOutcome } from './signing-module/progress';
import { normalizeEmail } from './signing-module/progress';
import type { SigningSubject } from './signing-module/provider';
import { SigningRefusal, type SigningSubscriber } from './signing-module/subscriber';
import { applySigningResult } from './transitions';
import type { Contract } from './types';

// prepareOutcome 的產出：簽署事件時間的證書判定，以席位 rule_id 為鍵（MIL-70）
interface PreparedSignSnapshots {
  snapshots: Record<string, SignatureSnapshot>;
}

export interface ContractSubscriberOptions {
  // 簽署事件時查登錄資料用。預設依環境選 adapter。
  registry?: () => PracticeRegistryResolution;
}

const AUTO_VOID_NOTE = '執業人員簽署時不可簽章，系統自動撤回';

// 合約層訂閱簽署事件：合約狀態是簽署進度的投影（ADR-0010 決議 7）。
// 轉移規則在 transitions.ts。文件保存與服務商任務編號都在簽署模組內，合約層不經手。
// 簽章紀錄（ADR-0018 決議 12）也在這裡寫：送簽交易內寫 snapshot_at_send，簽署事件交易內補 snapshot_at_sign。
export function createContractSubscriber({ registry = () => getPracticeRegistry() }: ContractSubscriberOptions = {}): SigningSubscriber {
  const contractOf = (subject: SigningSubject): Contract => {
    const contract = getContract(subject.id);
    if (!contract) throw new SigningRefusal(404, '合約不存在');
    return contract;
  };

  // 正在自動撤回的合約。撤回事件進交易時，歷程的行為者要記系統，不是出租人。
  const autoVoiding = new Set<number>();

  return {
    label: '合約',
    exists: (subject) => Boolean(getContract(subject.id)),
    currentStatus: (subject) => contractOf(subject).status,
    isCompleted: (subject) => contractOf(subject).status === 'completed',

    onSent(subject, { signers, context }) {
      const { role, name, email } = signers[0];
      const next = applySigningResult(contractOf(subject), { type: 'sent', first: { role, name, email } });
      if (!next) throw new SigningRefusal(409, '僅草稿可送簽');

      if (isContractSendContext(context)) {
        const records = context.records.map((record) => {
          const signer = signers[record.signerIndex];
          if (signer?.role !== 'practitioner') {
            throw new SigningRefusal(400, '簽章紀錄對不到執業人員簽署人，請重新送簽');
          }
          return { ...record, concurrentRoles: signer.concurrentRoles ?? [] };
        });
        insertSignatureRecords(getDb(), subject.id, records);
      } else if (signers.some((s) => s.role === 'practitioner')) {
        console.warn(`[signing] 合約 ${subject.id} 有執業人員簽署人，但送簽時沒有帶簽章紀錄資料`);
      }
    },

    // 簽署事件進交易之前，用事件時間重新判定還沒補快照的執業人員。
    // 登錄資料是非同步來源，不能在交易內查，所以在這裡先查好交給 onOutcome。
    async prepareOutcome(subject, event, eventAt) {
      if (event.type !== 'signed' && event.type !== 'completed') return undefined;
      const pending = listPendingSignRecords(getDb(), subject.id);
      if (pending.length === 0) return undefined;
      const resolution = registry();
      const entries = await Promise.all(
        pending.map(async (p): Promise<[string, SignatureSnapshot]> => {
          if (!resolution.available) return [p.ruleId, unavailableSnapshot(eventAt, resolution.reason)];
          try {
            const candidate = await resolution.registry.getPractitioner(p.practitionerId, { licenseKind: p.licenseKind });
            if (!candidate) return [p.ruleId, unavailableSnapshot(eventAt, '登錄查不到這位執業人員')];
            return [p.ruleId, buildCredentialSnapshot(candidate, eventAt)];
          } catch (e) {
            return [p.ruleId, unavailableSnapshot(eventAt, `查登錄資料失敗：${e instanceof Error ? e.message : String(e)}`)];
          }
        }),
      );
      return { snapshots: Object.fromEntries(entries) } satisfies PreparedSignSnapshots;
    },

    onOutcome(subject, outcome, context) {
      const autoVoid = outcome.type === 'voided' && autoVoiding.has(subject.id);
      applySigningResult(contractOf(subject), outcome, undefined, autoVoid ? { actor: 'system', note: AUTO_VOID_NOTE } : undefined);
      const written = completeSignSnapshots(subject, outcome, context.eventAt, context.prepared as PreparedSignSnapshots | undefined);
      recordLapsesFromSnapshots(subject, outcome, context.eventAt, written);
      settleLapses(subject, outcome);
    },

    // 簽署當下不可簽章且任務未結束：交易提交後才自動撤回，外部 API 不在交易內（ADR-0018 決議 11、ADR-0010 決議 8）。
    // 失敗不重試也不往外拋，記下失敗讓詳情頁顯示警示與撤回按鈕（ADR-0021 決議 7）。
    async afterOutcome(subject, outcome, { voidTask }) {
      if (outcome.type !== 'signer_signed' || !hasVoidPendingLapse(getDb(), subject.id)) return;
      autoVoiding.add(subject.id);
      try {
        await voidTask();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // 失敗狀態與歷程同一個交易
        const db = getDb();
        db.transaction(() => {
          if (!markVoidFailed(db, subject.id, message)) return;
          appendContractEvent(subject.id, {
            type: 'auto_void_failed',
            actor: 'system',
            note: `自動撤回失敗：${message}。請手動撤回。`,
          });
        })();
        console.error(`[signing] 合約 ${subject.id} 簽署時不可簽章，自動撤回失敗：${message}`);
      } finally {
        autoVoiding.delete(subject.id);
      }
    },

    // 文件保存已由簽署模組負責，合約完成後沒有其他處理
    afterCompleted: async () => {},

    // 簽署中卻沒有任務編號的舊合約沒有回填簽署任務，仍要能撤回
    voidWithoutTask(subject) {
      if (!applySigningResult(contractOf(subject), { type: 'voided' })) {
        throw new SigningRefusal(409, '僅簽署中的合約可撤回');
      }
    },
  };
}

// 與簽署進度同交易補 snapshot_at_sign。
// - 某位簽署人簽署：補對應那位執業人員的紀錄。
// - 全員完成：補所有還沒補的紀錄，也就是完成事件比該執業人員的簽署事件先到的情況，時間用完成事件的。
// - 拒簽與撤回：沒有簽署，不補。
function completeSignSnapshots(
  subject: SigningSubject,
  outcome: ProgressOutcome,
  eventAt: string,
  prepared: PreparedSignSnapshots | undefined,
): WrittenSignSnapshot[] {
  if (outcome.type !== 'signer_signed' && outcome.type !== 'completed') return [];
  const db = getDb();
  const pending = listPendingSignRecords(db, subject.id);
  const covered =
    outcome.type === 'completed'
      ? pending
      : pending.filter((p) => normalizeEmail(p.signerEmail) === normalizeEmail(outcome.signer.email));
  const written: WrittenSignSnapshot[] = [];
  for (const record of covered) {
    const snapshot =
      prepared?.snapshots[record.ruleId] ?? unavailableSnapshot(eventAt, '簽署事件到達時沒有取得登錄資料');
    if (completeSignSnapshot(db, subject.id, record.ruleId, snapshot)) written.push({ ruleId: record.ruleId, snapshot });
  }
  return written;
}

// 這次交易新補上的 snapshot_at_sign
interface WrittenSignSnapshot {
  ruleId: string;
  snapshot: SignatureSnapshot;
}

// 簽署事件的判定結果是不可簽章：簽署進度照常推進，記下失效事實（ADR-0018 決議 11 情況 B）。
// 判定沿用 prepareOutcome 用事件時間算出的快照，不重新查登錄。查不到登錄資料的快照無法判定，不當作失效。
// 只看這次新補的快照，重複的事件不會再補快照，所以不會重複記錄。
// - 任務未結束：記為等著自動撤回，由 afterOutcome 在交易提交後撤回。
// - 全員完成（含最後一位簽署人就是這位執業人員）：合約維持完成，只記事實，詳情頁顯示警示。
// ADR-0021 決議 6：稽核事件與通知的過渡做法是寫合約歷程。上線前改寫稽核事件（P0-23）。
function recordLapsesFromSnapshots(
  subject: SigningSubject,
  outcome: ProgressOutcome,
  eventAt: string,
  written: WrittenSignSnapshot[],
): void {
  const db = getDb();
  for (const { ruleId, snapshot } of written) {
    if (isUnavailableSnapshot(snapshot) || snapshot.result.signable) continue;
    const reasons = snapshot.result.issues.map((issue) => issue.message);
    // 最後一位簽完等於全員簽署，完成事件隨後就到，這時撤回只會與完成事件競態
    const completed = outcome.type === 'completed' || (outcome.type === 'signer_signed' && outcome.next === null);
    const recorded = recordLapse(db, {
      contractId: subject.id,
      ruleId,
      state: completed ? 'completed_lapsed' : 'void_pending',
      reasons,
      eventAt,
    });
    if (!recorded) continue;
    const detail = `${recorded.signerName}簽署時不可簽章（${reasons.join('、')}）。`;
    appendContractEvent(subject.id, {
      type: 'credential_lapsed',
      actor: 'system',
      note: detail + (completed ? '任務已全員完成，合約維持已完成。' : '簽署進度照常推進，系統將自動撤回。'),
    });
  }
}

// 任務結束時，結清先前記下、還沒處理完的失效紀錄
function settleLapses(subject: SigningSubject, outcome: ProgressOutcome): void {
  const db = getDb();
  switch (outcome.type) {
    case 'completed':
      // 撤回前全員已完成（例如自動撤回失敗後才收到完成事件）：合約維持完成
      for (const { signerName } of settleOpenLapses(db, subject.id, 'completed_lapsed')) {
        appendContractEvent(subject.id, {
          type: 'credential_lapsed',
          actor: 'system',
          note: `${signerName}簽署時不可簽章。任務之後全員完成，合約維持已完成。`,
        });
      }
      return;
    case 'voided':
      settleOpenLapses(db, subject.id, 'voided');
      return;
    case 'declined':
      settleOpenLapses(db, subject.id, 'task_ended');
      return;
    case 'signer_signed':
      return;
  }
}
