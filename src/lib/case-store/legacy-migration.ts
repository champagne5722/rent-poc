import { buildCaseEvent, type LeaseCaseState } from '../cases';
import { withTx } from '../pg/database';
import { createUlidFactory } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import {
  findOrCreateParty,
  insertCase,
  insertCaseEvent,
  insertCaseMember,
  normalizePartyEmail,
  setCurrentContract,
} from './repository';

// 既有合約遷移成自管租賃案件（ADR-0023 決議 3，MIL-115）。
//
// 做法選「可重跑的程序」，不放在 migration 檔內，理由：
// - A 線 MIL-90 在 migration 跑完之後才把 SQLite 的合約搬進 PostgreSQL。migration 跑的時候合約表還是空的，
//   資料步驟什麼都遷不到。MIL-90 搬完資料，呼叫 migrateContractsToCases() 一次（或呼叫內部 job
//   `migrate-contracts-to-cases`），之後新建的合約已經有案件，再跑是空操作。
// - 已經有案件的合約不動，所以可以重複執行，結果相同。部分組織失敗時修好重跑即可。
// - migration 檔以 app_owner 執行，不受 RLS 限制，而這裡逐組織以 app_rw 加 RLS 執行，與應用程式同一條路徑。
//
// 對應表（ADR-0023 決議 3）：
//   草稿 → draft。待乙方簽、待甲方簽、待執業人員簽 → signing。已完成 → active。
//   已拒簽、已撤回 → draft（合約本身維持原狀態）。
// 衍生關聯（derived_from）連在一起的合約歸同一案件，current_contract_id 指向最新一份（ID 最大者）。
// 承租人依最新一份「已送過簽」的合約的乙方 email 建立 lessee 成員。
// 出租人成員是遷移當下該組織的全部 admin（舊資料沒有建立者）。之後才加入的 admin 不會自動成為 lessor，
// 但主辦組織的成員本來就靠組織路徑讀取，不依賴 lessor 成員。
// 每個案件寫一筆 migrated 事件，不補寫歷史轉移。
//
// 只處理屋主組織（kind = 'owner'）的租賃合約。執業主體組織的合約由 MIL-116 建案件，委託管理合約由 MIL-119。
// 不呼叫 audit：遷移是維運動作，案件事件與 migrated 事件已記錄來源。

const STATE_BY_CONTRACT_STATUS: Record<string, LeaseCaseState> = {
  draft: 'draft',
  awaiting_tenant: 'signing',
  awaiting_landlord: 'signing',
  awaiting_practitioner: 'signing',
  completed: 'active',
  declined: 'draft',
  voided: 'draft',
};

/** 合約的分流條件是否說承租人是包租業者。沒有分流條件視為否。 */
function lesseeIsMasterLessor(fields: Record<string, unknown>): boolean {
  const routing = fields.routing;
  return typeof routing === 'object' && routing !== null && (routing as { lesseeIsMasterLessor?: unknown }).lesseeIsMasterLessor === true;
}

/** 遷移前的案件狀態：由合約狀態對應，未知狀態當 draft 並在結果裡計數。 */
export function caseStateForContract(status: string): LeaseCaseState {
  return STATE_BY_CONTRACT_STATUS[status] ?? 'draft';
}

interface ContractRow {
  id: string;
  status: string;
  derived_from: string | null;
  case_id: string | null;
  property_id: string | null;
  fields: Record<string, unknown>;
  created_at: Date;
  rental_unit_id: string | null;
  property_name: string | null;
  property_address: string | null;
}

export interface OrgMigrationResult {
  /** 這次新建的案件數。 */
  casesCreated: number;
  /** 掛上案件的合約數，含掛到既有案件的衍生合約。 */
  contractsLinked: number;
  /** 衍生合約的前身已有案件，這次改掛到那個案件的數量。 */
  attachedToExisting: number;
  /** 合約狀態不在對應表內，當作 draft 的案件數。 */
  unknownStatus: number;
}

export interface MigrationResult extends OrgMigrationResult {
  orgs: number;
  failedOrgs: string[];
}

const EMPTY: OrgMigrationResult = { casesCreated: 0, contractsLinked: 0, attachedToExisting: 0, unknownStatus: 0 };

/** 遷移一個組織。tx 必須是這個組織的脈絡。 */
export async function migrateOrgContractsToCases(tx: OrgTx, orgId: string, now: Date): Promise<OrgMigrationResult> {
  // 兩個行程同時遷移同一個組織時，後到的等先到的提交，再讀到的合約已經有案件，不會各建一個
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cases-legacy-migration:${orgId}`]);
  const { rows } = await tx.query<ContractRow>(
    `SELECT c.id, c.status, c.derived_from, c.case_id, c.property_id, c.fields, c.created_at,
            p.rental_unit_id, p.name AS property_name, p.address AS property_address
       FROM org.contracts c
       LEFT JOIN org.properties p ON p.org_id = c.org_id AND p.id = c.property_id
      WHERE c.org_id = $1 AND c.contract_type = 'lease'
      ORDER BY c.id`,
    [orgId],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const uncased = rows.filter((r) => r.case_id === null);
  if (uncased.length === 0) return { ...EMPTY };

  // 把衍生鏈串成群組：沿 derived_from 往前找到根（沒有前身，或前身已有案件）
  const rootOf = (row: ContractRow): ContractRow => {
    let current = row;
    const seen = new Set<string>();
    while (current.derived_from !== null && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.derived_from);
      if (!parent || parent.case_id !== null) break;
      current = parent;
    }
    return current;
  };
  const groups = new Map<string, ContractRow[]>();
  for (const row of uncased) {
    const root = rootOf(row);
    groups.set(root.id, [...(groups.get(root.id) ?? []), row]);
  }

  const admins = await tx.query<{ party_id: string }>(
    `SELECT u.party_id FROM control.org_memberships m JOIN control.users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND m.role = 'admin' ORDER BY m.created_at, m.id`,
    [orgId],
  );

  const result = { ...EMPTY };
  for (const members of groups.values()) {
    members.sort((a, b) => (a.id < b.id ? -1 : 1));
    const latest = members[members.length - 1];
    const root = members[0];

    // 前身已有案件：新合約掛進那個案件，不另建
    const parent = root.derived_from ? byId.get(root.derived_from) : undefined;
    if (parent?.case_id) {
      await tx.query(`UPDATE org.contracts SET case_id = $2 WHERE org_id = $1 AND id = ANY($3::text[])`, [
        orgId,
        parent.case_id,
        members.map((m) => m.id),
      ]);
      await setCurrentContract(tx, parent.case_id, latest.id, now);
      await insertCaseEvent(tx, parent.case_id, {
        event: buildCaseEvent('contract_attached', now, { contractId: latest.id, derivedFrom: latest.derived_from }),
      });
      result.contractsLinked += members.length;
      result.attachedToExisting += members.length;
      continue;
    }

    if (!(latest.status in STATE_BY_CONTRACT_STATUS)) result.unknownStatus += 1;
    const state = caseStateForContract(latest.status);
    // 案件 ID 的時間取自第一份合約的建立時間，案件清單的順序（ID 由新到舊）才與合約一致
    const caseId = createUlidFactory({ now: () => root.created_at.getTime() })();
    const fields = latest.fields as Record<string, unknown>;
    const text = (key: string) => (typeof fields[key] === 'string' ? (fields[key] as string).trim() : '');
    const name = latest.property_name ?? text('propertyName');
    const address = latest.property_address ?? text('propertyAddress');

    await insertCase(
      tx,
      {
        kind: 'lease',
        id: caseId,
        orgId,
        state: 'draft',
        stateVersion: 0,
        currentContractId: null,
        // 承租人是包租業者的自管案件歸為包租案件，與 migration 0077 的回填規則相同（ADR-0030 決議 2）
        caseKind: lesseeIsMasterLessor(fields) ? 'master_lease' : 'lease',
        businessType: 'self_managed',
        rentalUnitId: latest.rental_unit_id ?? '',
        linkedMandateCaseId: null,
        linkedMasterLeaseCaseId: null,
        predecessorCaseId: null,
        handoverId: null,
      },
      {
        title: name && address ? `${name}（${address}）` : name || address,
        propertyId: latest.property_id,
        rentalUnitId: latest.rental_unit_id,
        leaseStart: text('startDate') || null,
        leaseEnd: text('endDate') || null,
        monthlyRent: Number.isInteger(fields.rent) && (fields.rent as number) >= 0 ? (fields.rent as number) : null,
      },
      root.created_at,
    );
    // 建立時一律 draft，遷移再把狀態設到對應值，版本維持 0：遷移不是一次轉移
    if (state !== 'draft') await tx.query(`UPDATE org.cases SET state = $2 WHERE id = $1`, [caseId, state]);

    await tx.query(`UPDATE org.contracts SET case_id = $2 WHERE org_id = $1 AND id = ANY($3::text[])`, [
      orgId,
      caseId,
      members.map((m) => m.id),
    ]);
    await setCurrentContract(tx, caseId, latest.id, now);

    for (const admin of admins.rows) {
      await insertCaseMember(tx, caseId, { partyId: admin.party_id, relation: 'lessor' }, root.created_at);
    }
    // 承租人：最新一份已送過簽的合約。草稿沒有送出，乙方還沒有收到任何東西
    const sent = [...members].reverse().find((m) => m.status !== 'draft');
    const tenantEmail = sent ? String(sent.fields.tenantEmail ?? '') : '';
    if (sent && normalizePartyEmail(tenantEmail) !== null) {
      const partyId = await findOrCreateParty(tx, tenantEmail, String(sent.fields.tenantName ?? ''));
      await insertCaseMember(tx, caseId, { partyId, relation: 'lessee' }, root.created_at);
    }

    await insertCaseEvent(tx, caseId, {
      event: buildCaseEvent('migrated', now, {
        contractStatus: latest.status,
        contractCount: String(members.length),
        currentContractId: latest.id,
      }),
      toState: state,
    });
    result.casesCreated += 1;
    result.contractsLinked += members.length;
  }
  return result;
}

export interface MigrateOptions {
  now?: Date;
}

/**
 * 遷移全部屋主組織的既有租賃合約。逐組織一個交易，一個組織失敗不影響其他組織，失敗的組織 ID 放在結果裡。
 * 可重複執行：已有案件的合約不動。
 */
export async function migrateContractsToCases(options: MigrateOptions = {}): Promise<MigrationResult> {
  const now = options.now ?? new Date();
  const orgIds = (await withTx({ kind: 'control' }, (tx) => tx.query<{ id: string }>(`SELECT id FROM control.orgs WHERE kind = 'owner' ORDER BY id`))).rows.map(
    (r) => r.id,
  );
  const total: MigrationResult = { ...EMPTY, orgs: orgIds.length, failedOrgs: [] };
  for (const orgId of orgIds) {
    try {
      const r = await withTx({ kind: 'org', orgId }, (tx) => migrateOrgContractsToCases(tx, orgId, now));
      total.casesCreated += r.casesCreated;
      total.contractsLinked += r.contractsLinked;
      total.attachedToExisting += r.attachedToExisting;
      total.unknownStatus += r.unknownStatus;
    } catch (error) {
      total.failedOrgs.push(orgId);
      console.error(`[cases] 遷移組織 ${orgId} 失敗：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return total;
}
