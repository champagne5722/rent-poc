import { getContract, getDb } from './db';
import { getPracticeRegistry, type PracticeRegistryResolution } from './practice-registry';
import { completeSignSnapshot, insertSignatureRecords, listPendingSignRecords } from './signature-records/repository';
import { unavailableSnapshot, buildCredentialSnapshot, type SignatureSnapshot } from './signature-records/snapshot';
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

// 合約層訂閱簽署事件：合約狀態是簽署進度的投影（ADR-0010 決議 7）。
// 轉移規則在 transitions.ts。文件保存與服務商任務編號都在簽署模組內，合約層不經手。
// 簽章紀錄（ADR-0018 決議 12）也在這裡寫：送簽交易內寫 snapshot_at_send，簽署事件交易內補 snapshot_at_sign。
export function createContractSubscriber({ registry = () => getPracticeRegistry() }: ContractSubscriberOptions = {}): SigningSubscriber {
  const contractOf = (subject: SigningSubject): Contract => {
    const contract = getContract(subject.id);
    if (!contract) throw new SigningRefusal(404, '合約不存在');
    return contract;
  };

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
      applySigningResult(contractOf(subject), outcome);
      completeSignSnapshots(subject, outcome, context.eventAt, context.prepared as PreparedSignSnapshots | undefined);
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
): void {
  if (outcome.type !== 'signer_signed' && outcome.type !== 'completed') return;
  const db = getDb();
  const pending = listPendingSignRecords(db, subject.id);
  const covered =
    outcome.type === 'completed'
      ? pending
      : pending.filter((p) => normalizeEmail(p.signerEmail) === normalizeEmail(outcome.signer.email));
  for (const record of covered) {
    const snapshot =
      prepared?.snapshots[record.ruleId] ?? unavailableSnapshot(eventAt, '簽署事件到達時沒有取得登錄資料');
    completeSignSnapshot(db, subject.id, record.ruleId, snapshot);
  }
}
