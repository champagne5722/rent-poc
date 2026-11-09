import { appendAudit } from '../audit';
import {
  buildCaseEvent,
  decideCaseTransition,
  type CaseInput,
  type CaseSnapshot,
} from '../cases';
import type { OrgTx } from '../pg/with-tx';
import { getCase, insertCaseEvent } from './repository';
import { CaseNotFound, CaseVersionConflict, type CaseActor, type CaseRecord, type DispatchResult } from './types';

// dispatch()：案件狀態轉移的唯一入口（ADR-0016 決議 1、11，MIL-115）。
//
// 介面的規則：
// - 用呼叫端的 tx，不開交易。狀態、案件事件與稽核事件在同一個交易，任一失敗一起回滾。
// - 決策一律呼叫 decideCaseTransition，這裡不判斷哪個輸入在哪個狀態可以接受。
// - 以 state_version 做樂觀鎖。UPDATE 帶讀到的版本，版本不符丟 CaseVersionConflict，整個交易回滾，
//   由 webhook 的 inbox 重試。呼叫端有顯示畫面時，可以傳 expectedVersion 擋下「按下去時畫面已過期」。
// - 案件拒絕輸入時不丟錯：寫 input_rejected 事件並回 { ok: false }。合約的轉移照常提交，法律事實優先（決議 11）。
//   通知屋主或出租人的站內通知模組不在這條線，等通知模組併入後由呼叫端掛上。
// - 純函式回傳的 outbox 任務：audit_unsettled_close 在這裡寫成稽核事件。其餘任務（委託連結、關閉受託人 valid_period、
//   通知屋主移交）屬委託管理案件，由 MIL-119 處理，原樣放在回傳值裡，不會被吞掉。

export interface DispatchOptions {
  /** 時間由呼叫端傳入。預設是現在。 */
  now?: Date;
  /** 行為者。預設是系統。 */
  actor?: CaseActor;
  /** 畫面讀到的版本。與資料庫不同時丟 CaseVersionConflict。 */
  expectedVersion?: number;
}

export function snapshotOf(record: CaseRecord): CaseSnapshot {
  if (record.kind === 'lease') {
    if (record.businessType === null) throw new Error(`租賃案件 ${record.id} 沒有業務類型`);
    return {
      kind: 'lease',
      id: record.id,
      stateVersion: record.stateVersion,
      currentContractId: record.currentContractId,
      state: record.state as Extract<CaseSnapshot, { kind: 'lease' }>['state'],
      businessType: record.businessType,
    };
  }
  return {
    kind: 'management',
    id: record.id,
    stateVersion: record.stateVersion,
    currentContractId: record.currentContractId,
    state: record.state as Extract<CaseSnapshot, { kind: 'management' }>['state'],
    validUntil: record.validUntil,
  };
}

export async function dispatch(
  tx: OrgTx,
  caseId: string,
  input: CaseInput,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const now = options.now ?? new Date();
  const actorPartyId = options.actor?.partyId ?? null;

  const record = await getCase(tx, caseId);
  if (!record) throw new CaseNotFound(caseId);
  if (options.expectedVersion !== undefined && options.expectedVersion !== record.stateVersion) {
    throw new CaseVersionConflict(caseId);
  }

  const decision = decideCaseTransition(snapshotOf(record), input, now);
  if (!decision) {
    await insertCaseEvent(tx, caseId, {
      event: buildCaseEvent('input_rejected', now, rejectionPayload(record, input)),
      fromState: record.state,
      toState: record.state,
      actorPartyId,
    });
    return { ok: false, reason: 'rejected', state: record.state };
  }

  const { rows } = await tx.query(
    `UPDATE org.cases SET state = $2, state_version = state_version + 1, updated_at = $3
      WHERE id = $1 AND state_version = $4 RETURNING state_version`,
    [caseId, decision.state, now.toISOString(), record.stateVersion],
  );
  // 讀到之後被別的交易推進了
  if (rows.length === 0) throw new CaseVersionConflict(caseId);

  await insertCaseEvent(tx, caseId, {
    event: decision.event,
    fromState: record.state,
    toState: decision.state,
    actorPartyId,
  });

  for (const task of decision.outbox) {
    if (task.type === 'audit_unsettled_close') {
      // payload 只放案件 ID 與未結原因的種類。原因文字是使用者輸入，可能含個資，canonical 刪不掉（ADR-0019 決議 5）
      await appendAudit(tx, {
        action: 'case.unsettled_close',
        object: { type: 'case', id: task.caseId },
        payload: { case_event: decision.event.type },
      });
    }
  }

  return {
    ok: true,
    from: record.state,
    state: decision.state,
    stateVersion: (rows[0] as { state_version: number }).state_version,
    event: decision.event,
    outbox: decision.outbox,
  };
}

function rejectionPayload(record: CaseRecord, input: CaseInput): Record<string, string | null> {
  const payload: Record<string, string | null> = { inputType: input.type, state: record.state };
  if ('contractId' in input) {
    payload.contractId = input.contractId;
    payload.currentContractId = record.currentContractId;
  }
  return payload;
}
