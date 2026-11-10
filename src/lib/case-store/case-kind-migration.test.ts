import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caseKindOf, type StatutoryCaseKind } from '../cases';
import { migrate } from '../pg/migrate';
import { MIGRATIONS_DIR } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';

// MIL-195：migration 0077 加上 org.cases.case_kind，既有案件照 ADR-0030 決議 2 的對照表歸類。
// 做法：先只套用 0076 以前的 migration，用舊欄位寫入各種既有案件，再套用 0077，檢查筆數與歸類。
// org.cases 是 FORCE RLS，所以每次讀寫都先設定組織脈絡（app.org_id），與 migration 內的回填方式相同。

const MIGRATION = '0077_case_kind.sql';

interface Seed {
  label: string;
  orgId: string;
  kind: 'lease' | 'management';
  businessType: 'self_managed' | 'managed' | 'master_lease' | null;
  /** 目前合約的 fields.routing.lesseeIsMasterLessor。`undefined` 是合約沒有分流條件，`'no-contract'` 是沒有合約。 */
  routing: boolean | undefined | 'no-contract';
  expected: StatutoryCaseKind;
}

describe('案件種類回填（0077）', () => {
  let db: PGlite;
  let workDir: string;
  const ownerOrg = newUlid();
  const practiceOrg = newUlid();
  const seeds: Seed[] = [];
  const idOf = new Map<string, string>();

  const inOrg = async <T>(orgId: string, fn: () => Promise<T>): Promise<T> => {
    await db.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
    try {
      return await fn();
    } finally {
      await db.query(`SELECT set_config('app.org_id', '', false)`);
    }
  };

  async function seed(s: Seed): Promise<void> {
    const caseId = newUlid();
    idOf.set(s.label, caseId);
    seeds.push(s);
    await inOrg(s.orgId, async () => {
      await db.query(
        `INSERT INTO org.cases (id, org_id, kind, state, business_type, title)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [caseId, s.orgId, s.kind, 'active', s.businessType, s.label],
      );
      if (s.routing === 'no-contract') return;
      const contractId = newUlid();
      const fields = s.routing === undefined ? {} : { routing: { businessType: s.businessType, lesseeIsMasterLessor: s.routing, brokerMediated: false } };
      await db.query(
        `INSERT INTO org.contracts (id, org_id, case_id, fields, contract_type) VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [contractId, s.orgId, caseId, JSON.stringify(fields), s.kind === 'lease' ? 'lease' : 'management'],
      );
      await db.query(`UPDATE org.cases SET current_contract_id = $2 WHERE id = $1`, [caseId, contractId]);
    });
  }

  const countAll = async (): Promise<number> => {
    let total = 0;
    for (const orgId of [ownerOrg, practiceOrg]) {
      total += await inOrg(orgId, async () => Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM org.cases')).rows[0].n));
    }
    return total;
  };

  const kindsOf = async (orgId: string): Promise<Map<string, string>> =>
    inOrg(orgId, async () => {
      const { rows } = await db.query<{ title: string; case_kind: string }>('SELECT title, case_kind FROM org.cases');
      return new Map(rows.map((r) => [r.title, r.case_kind]));
    });

  let before = 0;

  beforeAll(async () => {
    // 只複製 0077 以前的 migration，模擬套用前的資料庫
    workDir = await mkdtemp(path.join(tmpdir(), 'mil195-'));
    for (const name of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql') && n < MIGRATION)) {
      await copyFile(path.join(MIGRATIONS_DIR, name), path.join(workDir, name));
    }
    db = new PGlite();
    await db.waitReady;
    await migrate(db, { dir: workDir, runAs: 'app_owner' });
    await db.exec('SET ROLE app_owner');
    for (const [id, kind, name] of [
      [ownerOrg, 'owner', '屋主組織'],
      [practiceOrg, 'practice', '業者組織'],
    ]) {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, $2, $3)`, [id, name, kind]);
    }

    // 屋主組織：自管、承租人是包租業者、沒有分流條件、沒有合約、代管、委託管理
    await seed({ label: '自管，承租人不是包租業者', orgId: ownerOrg, kind: 'lease', businessType: 'self_managed', routing: false, expected: 'lease' });
    await seed({ label: '自管，承租人是包租業者', orgId: ownerOrg, kind: 'lease', businessType: 'self_managed', routing: true, expected: 'master_lease' });
    await seed({ label: '自管，合約沒有分流條件', orgId: ownerOrg, kind: 'lease', businessType: 'self_managed', routing: undefined, expected: 'lease' });
    await seed({ label: '自管，沒有合約', orgId: ownerOrg, kind: 'lease', businessType: 'self_managed', routing: 'no-contract', expected: 'lease' });
    await seed({ label: '代管，旗標為真仍是租賃', orgId: ownerOrg, kind: 'lease', businessType: 'managed', routing: true, expected: 'lease' });
    await seed({ label: '委託管理', orgId: ownerOrg, kind: 'management', businessType: null, routing: 'no-contract', expected: 'management' });
    // 執業主體組織：舊值 master_lease 是轉租
    await seed({ label: '舊值 master_lease', orgId: practiceOrg, kind: 'lease', businessType: 'master_lease', routing: false, expected: 'sublease' });
    await seed({ label: '舊值 master_lease，旗標為真', orgId: practiceOrg, kind: 'lease', businessType: 'master_lease', routing: true, expected: 'sublease' });
    await seed({ label: '舊值 master_lease，沒有合約', orgId: practiceOrg, kind: 'lease', businessType: 'master_lease', routing: 'no-contract', expected: 'sublease' });
    await seed({ label: '業者的代管', orgId: practiceOrg, kind: 'lease', businessType: 'managed', routing: false, expected: 'lease' });
    await seed({ label: '業者的委託管理', orgId: practiceOrg, kind: 'management', businessType: null, routing: 'no-contract', expected: 'management' });

    // 所有組合，期望值由 caseKindOf 推出（它的對照表另有字面值測試：cases/case-kind.test.ts）
    for (const businessType of ['self_managed', 'managed', 'master_lease'] as const) {
      for (const lessee of [true, false]) {
        await seed({
          label: `組合 ${businessType} ${lessee}`,
          orgId: ownerOrg,
          kind: 'lease',
          businessType,
          routing: lessee,
          expected: caseKindOf({ kind: 'lease', businessType, lesseeIsMasterLessor: lessee }),
        });
      }
    }

    before = await countAll();
    const applied = await migrate(db, { dir: MIGRATIONS_DIR, runAs: 'app_owner' });
    expect(applied).toContain(MIGRATION);
  });

  afterAll(async () => {
    await db.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('遷移前後案件的筆數相同', async () => {
    expect(before).toBe(seeds.length);
    expect(await countAll()).toBe(before);
  });

  it('既有案件照 ADR-0030 決議 2 的對照表歸類', async () => {
    const actual = new Map([...(await kindsOf(ownerOrg)), ...(await kindsOf(practiceOrg))]);
    for (const s of seeds) expect({ label: s.label, caseKind: actual.get(s.label) }).toEqual({ label: s.label, caseKind: s.expected });
  });

  it('承租人是包租業者的自管租賃案件歸為包租案件，舊值 master_lease 的租賃案件歸為轉租案件', async () => {
    const owner = await kindsOf(ownerOrg);
    const practice = await kindsOf(practiceOrg);
    expect(owner.get('自管，承租人是包租業者')).toBe('master_lease');
    expect(practice.get('舊值 master_lease')).toBe('sublease');
  });

  it('舊欄位 kind 與 business_type 不變，舊的呼叫端仍讀得到', async () => {
    const rows = await inOrg(practiceOrg, async () =>
      (await db.query<{ kind: string; business_type: string | null }>(`SELECT kind, business_type FROM org.cases WHERE title = '舊值 master_lease'`)).rows,
    );
    expect(rows).toEqual([{ kind: 'lease', business_type: 'master_lease' }]);
  });

  describe('0077 之後的寫入', () => {
    const raw = (orgId: string, sql: string, params: unknown[] = []) => inOrg(orgId, () => db.query(sql, params));

    it('舊的呼叫端不寫 case_kind：trigger 補值，業務類型 master_lease 補成轉租，委託管理補成委託管理', async () => {
      const id1 = newUlid();
      const id2 = newUlid();
      const id3 = newUlid();
      await raw(practiceOrg, `INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', 'draft', 'master_lease', 'n1')`, [id1, practiceOrg]);
      await raw(practiceOrg, `INSERT INTO org.cases (id, org_id, kind, state, title) VALUES ($1, $2, 'management', 'draft', 'n2')`, [id2, practiceOrg]);
      await raw(practiceOrg, `INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', 'draft', 'self_managed', 'n3')`, [id3, practiceOrg]);
      const kinds = await kindsOf(practiceOrg);
      expect(kinds.get('n1')).toBe('sublease');
      expect(kinds.get('n2')).toBe('management');
      expect(kinds.get('n3')).toBe('lease');
    });

    it('明寫 case_kind 為 master_lease 且業務類型是 self_managed：允許（新的包租案件）', async () => {
      await raw(practiceOrg, `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, case_kind) VALUES ($1, $2, 'lease', 'draft', 'self_managed', 'ml', 'master_lease')`, [newUlid(), practiceOrg]);
      expect((await kindsOf(practiceOrg)).get('ml')).toBe('master_lease');
    });

    it.each([
      ['委託管理案件卻標成租賃', 'management', null, 'lease'],
      ['租賃案件卻標成委託管理', 'lease', 'managed', 'management'],
      ['代管租賃案件卻標成包租', 'lease', 'managed', 'master_lease'],
      ['舊值 master_lease 卻標成租賃', 'lease', 'master_lease', 'lease'],
      ['不在四個值內', 'lease', 'managed', 'rental'],
    ])('資料庫擋下矛盾的組合：%s', async (_name, kind, businessType, caseKind) => {
      await expect(
        raw(
          practiceOrg,
          `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, case_kind) VALUES ($1, $2, $3, 'draft', $4, 'x', $5)`,
          [newUlid(), practiceOrg, kind, businessType, caseKind],
        ),
      ).rejects.toThrow(/cases_case_kind/);
    });

    it('轉租案件可以連到同組織的包租案件', async () => {
      const master = newUlid();
      const sub = newUlid();
      await raw(practiceOrg, `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, case_kind) VALUES ($1, $2, 'lease', 'active', 'self_managed', 'm', 'master_lease')`, [master, practiceOrg]);
      await raw(practiceOrg, `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, linked_master_lease_case_id) VALUES ($1, $2, 'lease', 'draft', 'master_lease', 's', $3)`, [sub, practiceOrg, master]);
      const { rows } = await raw(practiceOrg, `SELECT linked_master_lease_case_id AS l FROM org.cases WHERE id = $1`, [sub]);
      expect(rows).toEqual([{ l: master }]);
    });

    it('只有轉租案件能填連結', async () => {
      const master = newUlid();
      await raw(practiceOrg, `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, case_kind) VALUES ($1, $2, 'lease', 'active', 'self_managed', 'm2', 'master_lease')`, [master, practiceOrg]);
      await expect(
        raw(practiceOrg, `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, linked_master_lease_case_id) VALUES ($1, $2, 'lease', 'draft', 'managed', 'x2', $3)`, [newUlid(), practiceOrg, master]),
      ).rejects.toThrow(/cases_linked_master_lease/);
    });

    it('連結不得指到別的組織的案件（複合外鍵）', async () => {
      const foreign = newUlid();
      await raw(ownerOrg, `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, case_kind) VALUES ($1, $2, 'lease', 'active', 'self_managed', 'f', 'master_lease')`, [foreign, ownerOrg]);
      await expect(
        raw(practiceOrg, `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, linked_master_lease_case_id) VALUES ($1, $2, 'lease', 'draft', 'master_lease', 'x3', $3)`, [newUlid(), practiceOrg, foreign]),
      ).rejects.toThrow(/foreign key|linked_master_lease/i);
    });
  });
});
