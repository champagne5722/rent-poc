import { PLATFORM_ORG_ID } from '../auth/config';
import { withTx } from '../pg/database';
import { actingOrgId, nextAnchorKey, TEST_PARTY_ID, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { parsePropertyCreateInput, registerProperty } from '../properties';
import { decideOwnershipFlow, type OperatorRuns } from './desk';
import { getOwnershipGate, precheckSubmission, recordTranscriptConsent, submitTranscript, type StoredTranscript } from './repository';

// 測試用：把一個物件推到指定的核對狀態（MIL-205）。
// 一律走正式的函式：同意個資告知、送出謄本（registry.submit_ownership_transcript）、
// 營運者判定（registry.decide_ownership_check，經 decideOwnershipFlow）。不直接寫 org.ownership_nodes。
// 物件要有建號（route 測試用 nextAnchorKey()）。只給 setupRouteDb 的測試用。

export type OwnershipStage = 'pending_verification' | 'verified' | 'failed';

export interface AdvanceOptions {
  /** 物件所屬的組織。預設是目前 actAs 的組織，沒有 actAs 時是 kit.orgA。 */
  orgId?: string;
  /** 送件的使用者。預設是 route 測試的固定使用者。 */
  partyId?: string;
}

/** 測試用的平台營運者。固定 ID，重複呼叫不重複建立。 */
const OPERATOR_USER_ID = '00000000000000000000000A01';
const OPERATOR_PARTY_ID = '00000000000000000000000A02';

async function ensureOperator(kit: RouteDb): Promise<void> {
  await kit.asOwner(async (db) => {
    await db.query(
      `INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'test-operator@example.com', '測試營運者') ON CONFLICT DO NOTHING`,
      [OPERATOR_PARTY_ID],
    );
    await db.query(`INSERT INTO control.users (id, party_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [OPERATOR_USER_ID, OPERATOR_PARTY_ID]);
    await db.query(
      `INSERT INTO control.org_memberships (id, org_id, user_id, role)
       SELECT $1, $2, $3, 'admin' WHERE NOT EXISTS (SELECT 1 FROM control.org_memberships WHERE org_id = $2 AND user_id = $3)`,
      [newUlid(), PLATFORM_ORG_ID, OPERATOR_USER_ID],
    );
  });
}

const operatorRuns: OperatorRuns = {
  platform: (ticketId, fn) => withTx({ kind: 'operator', operatorId: OPERATOR_USER_ID, orgId: PLATFORM_ORG_ID, ticketId }, (tx) => fn(tx as OrgTx)),
  inOrg: (orgId, ticketId, fn) => withTx({ kind: 'operator', operatorId: OPERATOR_USER_ID, orgId, ticketId }, (tx) => fn(tx as OrgTx)),
};

function fakeTranscript(orgId: string): StoredTranscript {
  const id = newUlid();
  return { id, objectKey: `org/${orgId}/transcripts/${id}.pdf`, sha256: 'a'.repeat(64), byteSize: 1, contentType: 'application/pdf', fileName: '測試謄本.pdf' };
}

/**
 * 把物件推到指定的核對狀態。物件已在較後面的狀態時，只做還需要的步驟：
 * 驗證失敗後再要 `verified`，會補件再判定；已驗證的物件再呼叫沒有動作。
 */
export async function advanceOwnership(
  kit: RouteDb,
  propertyId: string,
  stage: OwnershipStage,
  options: AdvanceOptions = {},
): Promise<void> {
  const orgId = options.orgId ?? actingOrgId() ?? kit.orgA;
  const partyId = options.partyId ?? TEST_PARTY_ID;
  const ctx = { kind: 'org', orgId, partyId } as const;

  const submitted = await withTx(ctx, async (tx) => {
    if (!(await recordTranscriptConsent(tx, propertyId, partyId, 'agree'))) throw new Error(`物件不存在：${propertyId}`);
    const pre = await precheckSubmission(tx, propertyId, partyId);
    if (!pre.ok) {
      if (pre.reason === 'already_pending' || pre.reason === 'already_verified') return null;
      throw new Error(`測試物件不能送出謄本：${pre.reason}`);
    }
    return submitTranscript(tx, pre.anchorId, { claimedOwner: '王大明', acquiredAt: new Date('2026-11-01T00:00:00Z'), trust: null }, fakeTranscript(orgId));
  });
  if (stage === 'pending_verification') return;
  if (submitted?.kind === 'already_verified' || (submitted === null && (await openItemId(kit, propertyId, orgId)) === null)) return;

  const itemId = await openItemId(kit, propertyId, orgId);
  if (!itemId) throw new Error('找不到待核對的審核項目');
  await ensureOperator(kit);
  const result = await decideOwnershipFlow(operatorRuns, itemId, {
    keyMatch: stage === 'verified',
    holderMatch: true,
    holderMasked: '王○明',
    reason: '測試核對',
  });
  if (result.status !== 'recorded') throw new Error(`判定失敗：${result.status}`);
}

/** 建立一個已核對的物件：同意告知、送出謄本、營運者判定通過。 */
export function verifyProperty(kit: RouteDb, propertyId: string, options: AdvanceOptions = {}): Promise<void> {
  return advanceOwnership(kit, propertyId, 'verified', options);
}

/** 這個物件目前待核對的審核項目 ID。沒有回 null。 */
async function openItemId(kit: RouteDb, propertyId: string, orgId: string): Promise<string | null> {
  const nodeId = await withTx({ kind: 'org', orgId, partyId: TEST_PARTY_ID }, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT n.id FROM org.properties p
         JOIN registry.get_anchors_for_units(ARRAY[p.rental_unit_id]) a ON true
         JOIN org.ownership_nodes n ON n.anchor_id = a.anchor_id AND n.status = 'pending_verification'
        WHERE p.id = $1`,
      [propertyId],
    );
    return rows[0]?.id ?? null;
  });
  if (!nodeId) return null;
  const items = await kit.asOwner(async (db) =>
    (await db.query<{ id: string }>(`SELECT id FROM registry.review_items WHERE type = 'leasing_authority' AND status = 'open' AND subject_id = $1`, [nodeId])).rows,
  );
  return items[0]?.id ?? null;
}

/**
 * 建立一個物件（走 registerProperty，帶建號），再推到指定的核對狀態。回傳物件 ID。
 * 不指定狀態時是已核對。直接寫 org.properties 的測試要改用這個，才能通過建立案件與送簽的檢查。
 */
export async function createPropertyAt(
  kit: RouteDb,
  stage: OwnershipStage | 'unsubmitted' = 'verified',
  options: AdvanceOptions & { name?: string } = {},
): Promise<string> {
  const orgId = options.orgId ?? actingOrgId() ?? kit.orgA;
  const partyId = options.partyId ?? TEST_PARTY_ID;
  const parsed = parsePropertyCreateInput({
    name: options.name ?? '測試物件',
    address: '台北市大安區某路 1 號',
    equipment: [],
    anchor: { key: nextAnchorKey() },
  });
  if (!parsed.ok) throw new Error(`測試物件的內容不合格：${parsed.error}`);
  const registered = await withTx({ kind: 'org', orgId, partyId }, (tx) => registerProperty(tx, parsed.value));
  if (stage !== 'unsubmitted') await advanceOwnership(kit, registered.id, stage, { orgId, partyId });
  return registered.id;
}

/** 建立一個已核對的物件。回傳物件 ID。 */
export function createVerifiedProperty(kit: RouteDb, options: AdvanceOptions & { name?: string } = {}): Promise<string> {
  return createPropertyAt(kit, 'verified', options);
}

/**
 * 把已驗證的節點轉成已失效。失效的入口屬 MIL-208，還沒有正式的函式，所以這裡用 app_owner 做合法的轉移（verified 到 lapsed）。
 * 只給「已失效」這一種狀態的測試用。其他狀態一律用 advanceOwnership。
 */
export async function lapseOwnership(kit: RouteDb, propertyId: string, options: AdvanceOptions = {}): Promise<void> {
  const orgId = options.orgId ?? actingOrgId() ?? kit.orgA;
  const nodeId = await withTx({ kind: 'org', orgId, partyId: TEST_PARTY_ID }, async (tx) => {
    const { rows } = await tx.query<{ rental_unit_id: string }>('SELECT rental_unit_id FROM org.properties WHERE id = $1', [propertyId]);
    return (await getOwnershipGate(tx, rows[0].rental_unit_id)).node?.id ?? null;
  });
  if (!nodeId) throw new Error('物件沒有節點，不能轉成已失效');
  await kit.asOwner(async (db) => {
    await db.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
    await db.query(`UPDATE org.ownership_nodes SET status = 'lapsed', status_changed_at = now(), updated_at = now() WHERE id = $1`, [nodeId]);
  });
}

/** `createLeaseCase` 的 property 參數：id、名稱、地址與租賃單位 ID。 */
export interface CaseProperty {
  id: string;
  name: string;
  address: string;
  rental_unit_id: string;
}

/** 讀物件的案件參數。 */
export async function casePropertyOf(kit: RouteDb, propertyId: string, options: AdvanceOptions = {}): Promise<CaseProperty> {
  const orgId = options.orgId ?? actingOrgId() ?? kit.orgA;
  return withTx({ kind: 'org', orgId, partyId: options.partyId ?? TEST_PARTY_ID }, async (tx) => {
    const { rows } = await tx.query<CaseProperty>('SELECT id, name, address, rental_unit_id FROM org.properties WHERE id = $1', [propertyId]);
    if (!rows[0]) throw new Error(`物件不存在：${propertyId}`);
    return rows[0];
  });
}

/** 建立一個已核對的物件，回傳給 `createLeaseCase` 用的 property 參數。 */
export async function createVerifiedCaseProperty(kit: RouteDb, options: AdvanceOptions & { name?: string } = {}): Promise<CaseProperty> {
  return casePropertyOf(kit, await createVerifiedProperty(kit, options), options);
}
