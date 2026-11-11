// 指派的 repository（MIL-69 建立，MIL-85 搬進 PostgreSQL，MIL-200 加案件成員）。
// 判定事實快照在 MIL-70 改由簽章紀錄承接，見 src/lib/signature-records/。
//
// 兩種來源，同一個形狀（MIL-200）：
// - 合約掛在案件下：指派存成案件成員（org.case_members 的席位欄，migration 0084）。簽章人員是案件的成員，
//   整批取代在草稿合約上做，案件成員同時只有一列有效。
// - 沒有案件的合約（舊路徑，MIL-203 移除）：指派表 org.contract_practitioner_assignments，說明見 db/migrations/0005。
// 案件成員那一邊多一個欄位：執業人員的 party ID 與關係（practitioner 或 broker），由呼叫端在交易外查登錄後帶進來，
// repository 不碰登錄（ADR-0012 決議 10）。
//
// 形狀照 src/lib/contracts/repository.ts：第一個參數是 withTx 給的 tx（OrgTx），
// 不傳 org_id：INSERT 取交易的 app.org_id，查詢靠 RLS 篩選。別的組織的合約和不存在的合約沒有差別。

import { getContractCaseId } from '../contracts/repository';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { PractitionerAssignmentInput } from './seats';

export type { PractitionerAssignmentInput };

export interface PractitionerAssignment extends PractitionerAssignmentInput {
  assignedAt: string;
}

/** 案件成員那一邊需要的席位資料：執業人員的 party 與關係。 */
export interface CaseSeatMember {
  slot: string;
  /** 執業人員自己的 party ID，登錄的 `PractitionerCandidate.partyId`。 */
  partyId: string;
  relation: 'practitioner' | 'broker';
}

interface AssignmentRow {
  slot: string;
  entity_id: string;
  practitioner_id: string;
  party_signer_id: string | null;
  assigned_at: Date;
}

const toAssignment = (r: AssignmentRow): PractitionerAssignment => ({
  slot: r.slot,
  entityId: r.entity_id,
  practitionerId: r.practitioner_id,
  partySignerId: r.party_signer_id,
  assignedAt: r.assigned_at.toISOString(),
});

async function legacyAssignments(tx: OrgTx, contractId: string): Promise<PractitionerAssignment[]> {
  const { rows } = await tx.query<AssignmentRow>(
    `SELECT slot, entity_id, practitioner_id, party_signer_id, assigned_at
       FROM org.contract_practitioner_assignments WHERE contract_id = $1 ORDER BY slot`,
    [contractId],
  );
  return rows.map(toAssignment);
}

async function caseAssignments(tx: OrgTx, caseId: string): Promise<PractitionerAssignment[]> {
  const { rows } = await tx.query<AssignmentRow>(
    `SELECT slot, entity_id, employment_id AS practitioner_id, party_signer_id, lower(valid_period) AS assigned_at
       FROM org.case_members
      WHERE case_id = $1 AND slot IS NOT NULL AND valid_period @> now() ORDER BY slot`,
    [caseId],
  );
  return rows.map(toAssignment);
}

/**
 * 合約的指派。合約掛在案件下時讀案件成員，沒有案件讀舊表。
 * 搬資料時搬不動的舊列（migration 0084）留在舊表：案件裡沒有那個席位時，仍補上舊列，送簽前檢查會說明原因。
 */
export async function getAssignments(tx: OrgTx, contractId: string): Promise<PractitionerAssignment[]> {
  const caseId = await getContractCaseId(tx, contractId);
  if (!caseId) return legacyAssignments(tx, contractId);
  const fromCase = await caseAssignments(tx, caseId);
  const covered = new Set(fromCase.map((a) => a.slot));
  const leftovers = (await legacyAssignments(tx, contractId)).filter((a) => !covered.has(a.slot));
  return [...fromCase, ...leftovers].sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
}

const INSERT_ASSIGNMENT = `INSERT INTO org.contract_practitioner_assignments
    (id, org_id, contract_id, slot, entity_id, practitioner_id, party_signer_id)
  VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6)`;

const INSERT_SEAT_MEMBER = `INSERT INTO org.case_members
    (id, org_id, case_id, party_id, relation, slot, entity_id, employment_id, party_signer_id)
  VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6, $7, $8)`;

/**
 * 整批取代。改派與取消都走這裡，不留舊資料。同一個席位出現兩次時整批拒絕（唯一鍵），交易回滾。
 * 合約不存在（含別的組織的合約）時複合外鍵擋下。
 *
 * 合約掛在案件下時，指派寫成案件成員，`seats` 必須涵蓋每一個指派的席位（執業人員的 party 與關係），缺少時丟錯。
 * 同一個案件的席位成員整批取代：先刪掉案件上所有帶席位欄的成員，再寫新的。一般成員（承租人、共同承租人等）不動。
 * 沒有案件的合約不看 `seats`。
 */
export async function replaceAssignments(
  tx: OrgTx,
  contractId: string,
  assignments: readonly PractitionerAssignmentInput[],
  seats: readonly CaseSeatMember[] = [],
): Promise<void> {
  const caseId = await getContractCaseId(tx, contractId);
  // 舊表的列一律清掉：案件下的合約搬資料後不該再有舊列，沒搬走的舊列由這次的整批取代一併換掉
  await tx.query('DELETE FROM org.contract_practitioner_assignments WHERE contract_id = $1', [contractId]);
  if (!caseId) {
    for (const a of assignments) {
      await tx.query(INSERT_ASSIGNMENT, [newUlid(), contractId, a.slot, a.entityId, a.practitionerId, a.partySignerId]);
    }
    return;
  }
  const seatBySlot = new Map(seats.map((s) => [s.slot, s]));
  for (const a of assignments) {
    if (!seatBySlot.has(a.slot)) throw new Error(`案件下的指派缺少席位成員資料：${a.slot}`);
  }
  await tx.query('DELETE FROM org.case_members WHERE case_id = $1 AND slot IS NOT NULL', [caseId]);
  for (const a of assignments) {
    const seat = seatBySlot.get(a.slot)!;
    await tx.query(INSERT_SEAT_MEMBER, [
      newUlid(),
      caseId,
      seat.partyId,
      seat.relation,
      a.slot,
      a.entityId,
      a.practitionerId,
      a.partySignerId,
    ]);
  }
}

/**
 * 複製為新草稿時沿用指派。送簽前仍會重新檢查，所以失效的人不會被帶過去簽。
 * 新草稿掛在案件下時，指派就是案件的席位成員，不必複製。新草稿沒有案件時，複製成舊表的列。
 */
export async function copyAssignments(tx: OrgTx, fromContractId: string, toContractId: string): Promise<void> {
  if (await getContractCaseId(tx, toContractId)) return;
  for (const a of await getAssignments(tx, fromContractId)) {
    await tx.query(INSERT_ASSIGNMENT, [newUlid(), toContractId, a.slot, a.entityId, a.practitionerId, a.partySignerId]);
  }
}
