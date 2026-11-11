import { newUlid } from '../pg/ulid';
import { TEST_PARTY_ID, TEST_USER_ID, type RouteDb } from '../pg/route-test-kit';

// 測試用：備好「從物件建立案件」需要的資料（MIL-209）。只給 setupRouteDb 的測試用，用 app_owner 直接寫。
// 資格事實的來源是 registry 的業別、證書與任職，以及組織成員（registry.org_employments 要成員脈絡）。

export interface PracticeSeedOptions {
  orgId: string;
  /** 各業別的狀態。預設代管與包租都是 verified。null 代表沒有登錄這個業別。 */
  licenses?: { management?: 'pending' | 'verified' | 'lapsed' | null; master_lease?: 'pending' | 'verified' | 'lapsed' | null };
  /** 預設有一位已驗證、任職中的租賃住宅管理人員。 */
  withManager?: boolean;
}

/** 把一個組織備成可建包租、轉租與代管案件的執業主體（走資料庫直接寫，不走送件流程）。 */
export async function seedPracticeOrg(kit: RouteDb, options: PracticeSeedOptions): Promise<void> {
  const licenses = { management: 'verified', master_lease: 'verified', ...options.licenses } as Record<'management' | 'master_lease', string | null>;
  const entityId = newUlid();
  const key = `rental_housing_manager:112:內授營:${Math.floor(100000 + Math.random() * 899999)}`;
  await kit.asOwner(async (db) => {
    await db.query(`INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, $2, '測試管理公司', 'company', $3)`, [
      entityId,
      String(Math.floor(10000000 + Math.random() * 89999999)),
      options.orgId,
    ]);
    for (const kind of ['management', 'master_lease'] as const) {
      if (licenses[kind] !== null) {
        await db.query(`INSERT INTO registry.practice_licenses (id, entity_id, kind, state) VALUES ($1, $2, $3, $4)`, [newUlid(), entityId, kind, licenses[kind]]);
      }
    }
    // registry.org_employments 要求呼叫者是組織成員
    await db.query(`INSERT INTO control.users (id, party_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [TEST_USER_ID, TEST_PARTY_ID]);
    await db.query(
      `INSERT INTO control.org_memberships (id, org_id, user_id, role)
       SELECT $1, $2, $3, 'admin' WHERE NOT EXISTS (SELECT 1 FROM control.org_memberships WHERE org_id = $2 AND user_id = $3)`,
      [newUlid(), options.orgId, TEST_USER_ID],
    );
    if (options.withManager === false) return;
    const practitionerId = newUlid();
    await db.query(
      `INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until, state)
       VALUES ($1, $2, 'rental_housing_manager', '112', '內授營', $3, $4, '2024-03-01', '2036-03-01', 'verified')`,
      [practitionerId, TEST_PARTY_ID, key.split(':')[3], key],
    );
    await db.query(
      `INSERT INTO registry.practitioner_employments (id, practitioner_id, certificate_key, certificate_kind, entity_id, state, started_on)
       VALUES ($1, $2, $3, 'rental_housing_manager', $4, 'verified', '2026-01-01')`,
      [newUlid(), practitionerId, key, entityId],
    );
  });
}

/**
 * 備好一份自家的有效委託管理案件，委託標的含這個物件（代管的租賃案件要連到它）。
 * 結構與 `findCoveringMandateCase` 查的一致：案件的目前合約有一列委託標的，`property_id` 是物件 ID。
 */
export async function seedMandateCase(kit: RouteDb, input: { orgId: string; propertyId: string; state?: 'draft' | 'active' }): Promise<string> {
  const caseId = newUlid();
  const contractId = newUlid();
  await kit.asOwner(async (db) => {
    await db.query(`SELECT set_config('app.org_id', $1, false)`, [input.orgId]);
    await db.query(
      `INSERT INTO org.contracts (id, org_id, property_id, contract_type, fields, signature_fields) VALUES ($1, $2, NULL, 'management', '{}'::jsonb, '[]'::jsonb)`,
      [contractId, input.orgId],
    );
    await db.query(
      `INSERT INTO org.cases (id, org_id, kind, state, case_kind, title, current_contract_id) VALUES ($1, $2, 'management', $3, 'management', '測試委託管理案件', $4)`,
      [caseId, input.orgId, input.state ?? 'active', contractId],
    );
    await db.query(
      `INSERT INTO org.contract_mandate_items (id, org_id, contract_id, position, property_id, property_name, property_address, scopes)
       VALUES ($1, $2, $3, 0, $4, '物件', '地址', '["rent"]'::jsonb)`,
      [newUlid(), input.orgId, contractId, input.propertyId],
    );
  });
  return caseId;
}

/** 把案件推到 active。包租案件建立時是 draft，轉租案件要連到 active 的包租案件。 */
export async function activateCase(kit: RouteDb, orgId: string, caseId: string): Promise<void> {
  await kit.asOwner(async (db) => {
    await db.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
    await db.query(`UPDATE org.cases SET state = 'active' WHERE id = $1`, [caseId]);
  });
}
