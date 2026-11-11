import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../pg/migrate';
import { MIGRATIONS_DIR } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';

// MIL-200：migration 0084 把合約上既有的執業人員指派搬成案件成員（org.case_members 的席位欄）。
// 做法照 case-kind-migration.test.ts：先只套用 0084 以前的 migration，用舊表寫入各種既有指派，再套用 0084，檢查搬了哪些、留了哪些。
// org 的表是 FORCE RLS，所以每次讀寫都先設定組織脈絡（app.org_id），與 migration 內的搬法相同。

const MIGRATION = '0084_signers_from_own_org_only.sql';

describe('既有指派搬成案件成員（0084）', () => {
  let db: PGlite;
  let workDir: string;
  const orgA = newUlid();
  const orgB = newUlid();
  const entityA = newUlid();
  const entityB = newUlid();
  const id = {
    casedContract: newUlid(),
    uncasedContract: newUlid(),
    foreignContract: newUlid(),
    twinContract: newUlid(),
    caseA: newUlid(),
    caseB: newUlid(),
    managerEmployment: newUlid(),
    brokerEmployment: newUlid(),
    foreignEmployment: newUlid(),
    managerParty: newUlid(),
    brokerParty: newUlid(),
    foreignParty: newUlid(),
    assignManager: newUlid(),
    assignBroker: newUlid(),
    assignUncased: newUlid(),
    assignForeign: newUlid(),
    assignMissingEmployment: newUlid(),
    assignTwin: newUlid(),
  };
  const MANAGER_SLOT = 'lease.master_lease.practitioner';
  const BROKER_SLOT = 'lease.broker';

  const inOrg = async <T,>(orgId: string, fn: () => Promise<T>): Promise<T> => {
    await db.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
    try {
      return await fn();
    } finally {
      await db.query(`SELECT set_config('app.org_id', '', false)`);
    }
  };

  async function credential(partyId: string, entityId: string, employmentId: string, kind: string, serial: string): Promise<void> {
    const practitionerId = newUlid();
    const key = `${kind}:112:內授營:${serial}`;
    await db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)`, [partyId, `${partyId.toLowerCase()}@members.test`, `人員${serial}`]);
    await db.query(
      `INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until, state)
       VALUES ($1, $2, $3, '112', '內授營', $4, $5, '2023-03-01', '2029-12-31', 'verified')`,
      [practitionerId, partyId, kind, serial, key],
    );
    await db.query(
      `INSERT INTO registry.practitioner_employments (id, practitioner_id, certificate_key, certificate_kind, entity_id, state, started_on)
       VALUES ($1, $2, $3, $4, $5, 'verified', '2024-01-01')`,
      [employmentId, practitionerId, key, kind, entityId],
    );
  }

  const insertAssignment = (orgId: string, assignmentId: string, contractId: string, slot: string, entityId: string, employmentId: string, signer: string | null) =>
    inOrg(orgId, () =>
      db.query(
        `INSERT INTO org.contract_practitioner_assignments (id, org_id, contract_id, slot, entity_id, practitioner_id, party_signer_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [assignmentId, orgId, contractId, slot, entityId, employmentId, signer],
      ),
    );

  const legacyRows = (orgId: string) =>
    inOrg(orgId, async () => (await db.query<{ id: string }>('SELECT id FROM org.contract_practitioner_assignments ORDER BY id')).rows.map((r) => r.id));
  const seatRows = (orgId: string) =>
    inOrg(orgId, async () =>
      (
        await db.query<{ id: string; case_id: string; party_id: string; relation: string; slot: string; entity_id: string; employment_id: string; party_signer_id: string | null }>(
          'SELECT id, case_id, party_id, relation, slot, entity_id, employment_id, party_signer_id FROM org.case_members WHERE slot IS NOT NULL ORDER BY slot, id',
        )
      ).rows,
    );

  beforeAll(async () => {
    // 只複製 0084 以前的 migration，模擬套用前的資料庫
    workDir = await mkdtemp(path.join(tmpdir(), 'mil200-'));
    for (const name of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql') && n < MIGRATION)) {
      await copyFile(path.join(MIGRATIONS_DIR, name), path.join(workDir, name));
    }
    db = new PGlite();
    await db.waitReady;
    await migrate(db, { dir: workDir, runAs: 'app_owner' });
    await db.exec('SET ROLE app_owner');
    for (const [orgId, name] of [
      [orgA, '業者甲'],
      [orgB, '業者乙'],
    ]) {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, $2, 'practice')`, [orgId, name]);
    }
    await db.query(`INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, '11111111', '甲公司', 'company', $2)`, [entityA, orgA]);
    await db.query(`INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, '22222222', '乙公司', 'company', $2)`, [entityB, orgB]);
    await credential(id.managerParty, entityA, id.managerEmployment, 'rental_housing_manager', '1000001');
    await credential(id.brokerParty, entityA, id.brokerEmployment, 'real_estate_broker', '2000001');
    await credential(id.foreignParty, entityB, id.foreignEmployment, 'rental_housing_manager', '3000001');

    // 甲：合約有案件、合約沒有案件、案件下的另一份合約（同一席位）
    await inOrg(orgA, async () => {
      await db.query(`INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', 'draft', 'master_lease', '甲的案件')`, [id.caseA, orgA]);
      for (const [contractId, caseId] of [
        [id.casedContract, id.caseA],
        [id.twinContract, id.caseA],
        [id.uncasedContract, null],
        [id.foreignContract, id.caseA],
      ]) {
        await db.query(`INSERT INTO org.contracts (id, org_id, case_id, fields, contract_type) VALUES ($1, $2, $3, '{}'::jsonb, 'lease')`, [contractId, orgA, caseId]);
      }
    });
    // 案件下另一份合約的同一個席位，指派得比較早：案件的席位只有一列，最新的指派優先，這一列留在舊表
    await insertAssignment(orgA, id.assignTwin, id.twinContract, MANAGER_SLOT, entityA, id.managerEmployment, null);
    await db.query(`SELECT pg_sleep(0.01)`);
    // 有案件的合約：專任管理人員（含當事人簽署人）與經紀人
    await insertAssignment(orgA, id.assignManager, id.casedContract, MANAGER_SLOT, entityA, id.managerEmployment, 'membership-1');
    await insertAssignment(orgA, id.assignBroker, id.casedContract, BROKER_SLOT, entityA, id.brokerEmployment, null);
    // 沒有案件的合約：不搬
    await insertAssignment(orgA, id.assignUncased, id.uncasedContract, MANAGER_SLOT, entityA, id.managerEmployment, null);
    // 有案件，但指派指向別的組織的執業主體（要關掉的洞）：不搬
    await insertAssignment(orgA, id.assignForeign, id.foreignContract, MANAGER_SLOT, entityB, id.foreignEmployment, null);
    // 有案件，但任職查不到：不搬
    await insertAssignment(orgA, id.assignMissingEmployment, id.foreignContract, BROKER_SLOT, entityA, newUlid(), null);

    const applied = await migrate(db, { dir: MIGRATIONS_DIR, runAs: 'app_owner' });
    expect(applied).toContain(MIGRATION);
  });

  afterAll(async () => {
    await db.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('有案件、執業主體屬於同一個組織的指派搬成案件成員，relation 依證書種類，席位欄原樣帶過去', async () => {
    const rows = await seatRows(orgA);
    expect(rows.map((r) => [r.slot, r.relation, r.entity_id, r.employment_id, r.party_signer_id, r.case_id, r.party_id])).toEqual([
      [BROKER_SLOT, 'broker', entityA, id.brokerEmployment, null, id.caseA, id.brokerParty],
      [MANAGER_SLOT, 'practitioner', entityA, id.managerEmployment, 'membership-1', id.caseA, id.managerParty],
    ]);
  });

  it('搬走的舊列刪掉，搬不動的留在舊表：沒有案件、別的組織的執業主體、任職查不到、案件席位已有人', async () => {
    expect((await legacyRows(orgA)).sort()).toEqual([id.assignUncased, id.assignForeign, id.assignMissingEmployment, id.assignTwin].sort());
  });

  it('別的組織的執業主體沒有被搬成案件成員：案件成員裡找不到乙的人', async () => {
    const rows = await seatRows(orgA);
    expect(rows.some((r) => r.entity_id === entityB || r.party_id === id.foreignParty)).toBe(false);
  });

  it('重跑搬資料的 SQL 不會重複寫：筆數不變', async () => {
    const sql = (await import('node:fs/promises')).readFile(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
    const text = await sql;
    const block = text.slice(text.lastIndexOf('DO $$'));
    const before = { seats: (await seatRows(orgA)).length, legacy: (await legacyRows(orgA)).length };
    await db.exec(block);
    expect({ seats: (await seatRows(orgA)).length, legacy: (await legacyRows(orgA)).length }).toEqual(before);
  });

  it('沒有其他組織的資料被動到：乙沒有任何指派或席位成員', async () => {
    expect(await legacyRows(orgB)).toEqual([]);
    expect(await seatRows(orgB)).toEqual([]);
  });
});
