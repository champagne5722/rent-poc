import { beforeEach, describe, expect, it } from 'vitest';
import { ORG_TABLE_CASES, REGISTRY_FUNCTION_CASES } from './rls-cases';
import { newUlid } from './ulid';
import type { Tx, WithTx } from './with-tx';

// 跨組織滲透探測的測試本體（MIL-81 建，MIL-89 抽成共用）。
// rls-penetration.test.ts（PGlite）與 rls-penetration.pg.test.ts（真實 PostgreSQL）共用同一份探測，
// 所以兩個資料庫引擎驗的是同一組行為。

export interface PenetrationEnv {
  /**
   * 每個測試前呼叫。建好 control.orgs 的兩個組織並回傳以 app_rw 身分運作的 withTx。
   * orgA、orgB 每個測試都是新的 ULID，所以可以共用同一個資料庫。
   */
  prepare(orgA: string, orgB: string): Promise<WithTx>;
}

/** 每張 org 表的通用探測：自己看得到，別的組織看不到、改不到、刪不到，寫入別人的 org_id 被擋，業務鍵撞號不洩漏。 */
export function describeOrgTablePenetration(env: PenetrationEnv) {
  describe.each(Object.entries(ORG_TABLE_CASES))('%s 的跨組織探測', (table, testCase) => {
    let withTx: WithTx;
    let orgA: string;
    let orgB: string;

    beforeEach(async () => {
      orgA = newUlid();
      orgB = newUlid();
      withTx = await env.prepare(orgA, orgB);
    });

    const seedA = () => withTx({ kind: 'org', orgId: orgA }, (tx) => testCase.seed(tx, orgA));
    const asB = <T>(fn: (tx: Tx<'org'>) => Promise<T>) => withTx({ kind: 'org', orgId: orgB }, fn);

    it('自己看得到這一列', async () => {
      const id = await seedA();
      const rows = await withTx({ kind: 'org', orgId: orgA }, (tx) => tx.query(`SELECT id FROM ${table} WHERE id = $1`, [id]));
      expect(rows.rows).toHaveLength(1);
    });

    it('別的組織看不到、改不到、刪不到', async () => {
      const id = await seedA();
      expect((await asB((tx) => tx.query(`SELECT id FROM ${table} WHERE id = $1`, [id]))).rows).toEqual([]);
      expect((await asB((tx) => tx.query(`SELECT count(*)::int AS n FROM ${table}`))).rows).toEqual([{ n: 0 }]);
      if (testCase.appendOnly) {
        // 只增不改的表：app_rw 沒有 UPDATE 與 DELETE 權限，連別的組織的列也不必碰就被擋
        await expect(asB((tx) => tx.query(`UPDATE ${table} SET org_id = org_id WHERE id = $1 RETURNING id`, [id]))).rejects.toThrow(/permission denied/);
        await expect(asB((tx) => tx.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [id]))).rejects.toThrow(/permission denied/);
      } else {
        expect((await asB((tx) => tx.query(`UPDATE ${table} SET org_id = org_id WHERE id = $1 RETURNING id`, [id]))).rows).toEqual([]);
        expect((await asB((tx) => tx.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [id]))).rows).toEqual([]);
      }
      const stillThere = await withTx({ kind: 'org', orgId: orgA }, (tx) => tx.query(`SELECT id FROM ${table} WHERE id = $1`, [id]));
      expect(stillThere.rows).toHaveLength(1);
    });

    it('不能把列的 org_id 改成別的組織', async () => {
      const id = await seedA();
      await expect(
        withTx({ kind: 'org', orgId: orgA }, (tx) => tx.query(`UPDATE ${table} SET org_id = $2 WHERE id = $1`, [id, orgB])),
      ).rejects.toThrow(testCase.appendOnly ? /permission denied/ : (testCase.blockedUpdateMessage ?? /row-level security/));
    });

    it('在自己的脈絡寫入別的組織的 org_id，被 RLS 擋下', async () => {
      await expect(withTx({ kind: 'org', orgId: orgA }, (tx) => testCase.seed(tx, orgB))).rejects.toThrow(/row-level security/);
    });

    it('沒有組織脈絡（control）時 0 筆', async () => {
      await seedA();
      const rows = await withTx({ kind: 'control' }, (tx) => tx.query(`SELECT count(*)::int AS n FROM ${table}`));
      expect(rows.rows).toEqual([{ n: 0 }]);
    });

    it('只有 party 脈絡（承租人）時 0 筆', async () => {
      await seedA();
      const rows = await withTx({ kind: 'party', partyId: newUlid() }, (tx) => tx.query(`SELECT count(*)::int AS n FROM ${table}`));
      expect(rows.rows).toEqual([{ n: 0 }]);
    });

    it('兩個組織用同一組業務鍵各寫一列都成功，撞號不會洩漏別的組織有這一列（陷阱 6）', async () => {
      await seedA();
      await expect(asB((tx) => testCase.seed(tx, orgB))).resolves.toBeTruthy();
    });
  });
}

/** registry 函式的跨組織探測：B 組織探測 A 組織的 ID 與探測不存在的 ID，結果逐位元相同。 */
export function describeRegistryFunctionPenetration(env: PenetrationEnv) {
  describe.each(Object.entries(REGISTRY_FUNCTION_CASES).filter(([, c]) => c.probe !== null))('%s 的跨組織探測', (_name, fnCase) => {
    it('B 組織探測 A 組織的 ID，與探測不存在的 ID，結果逐位元相同', async () => {
      const orgA = newUlid();
      const orgB = newUlid();
      const withTx = await env.prepare(orgA, orgB);
      const target = await withTx({ kind: 'org', orgId: orgA }, async (tx) => {
        const anchorId = newUlid();
        const unitId = newUlid();
        await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [anchorId, unitId, '滲透測試地址']);
        await tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [
          newUlid(),
          orgA,
          unitId,
          '滲透測試物件',
          '滲透測試地址',
        ]);
        return { anchorId, unitId };
      });
      const outcome = (t: { anchorId: string; unitId: string }) =>
        withTx({ kind: 'org', orgId: orgB }, (tx) => fnCase.probe!(tx, t)).then(
          (value) => ({ value }),
          (error: { code?: string; message?: string }) => ({ error: { code: error.code, message: error.message } }),
        );
      expect(await outcome(target)).toEqual(await outcome({ anchorId: newUlid(), unitId: newUlid() }));
    });
  });
}

/**
 * 外鍵穿透（陷阱 5）：B 組織用 A 組織的列 ID 當外鍵，錯誤必須與用不存在的 ID 完全一樣。
 * 外鍵檢查不受 RLS 約束，單欄外鍵會讓 B 區分「A 有這一列」與「沒有這一列」。複合外鍵 (org_id, x_id) 讓兩者都是外鍵違規。
 * 哪些外鍵是複合的由 rls-catalog-kit.ts 的 foreignKeyViolations 逐一檢查，這裡驗證行為。
 */
export function describeForeignKeyPenetration(env: PenetrationEnv) {
  describe('外鍵穿透（陷阱 5）', () => {
    const PARTY_ID = '0000000000000000000000PEN1';

    const outcome = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return { ok: true as const };
      } catch (e) {
        const error = e as { code?: string; constraint?: string; message?: string };
        // 訊息可能含被探測的 ID，比對前換成固定字樣
        const message = (error.message ?? '').replace(/[0-9A-HJKMNP-TV-Z]{26}/g, '<ULID>');
        return { ok: false as const, code: error.code, constraint: error.constraint, message };
      }
    };

    it('B 組織用 A 組織的案件 ID 建成員，與用不存在的案件 ID 得到相同的外鍵錯誤', async () => {
      const orgA = newUlid();
      const orgB = newUlid();
      const withTx = await env.prepare(orgA, orgB);
      const caseOfA = await withTx({ kind: 'org', orgId: orgA }, (tx) => ORG_TABLE_CASES['org.cases'].seed(tx, orgA));
      const addMember = (caseId: string) =>
        outcome(() =>
          withTx({ kind: 'org', orgId: orgB }, async (tx) => {
            await tx.query(
              `INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'penetration-member@example.com', '滲透測試成員') ON CONFLICT DO NOTHING`,
              [PARTY_ID],
            );
            await tx.query(
              `INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'lessor')`,
              [newUlid(), orgB, caseId, PARTY_ID],
            );
          }),
        );
      const real = await addMember(caseOfA);
      const missing = await addMember(newUlid());
      expect(real).toMatchObject({ ok: false, code: '23503', constraint: 'case_members_org_id_case_id_fkey' });
      expect(real).toEqual(missing);
    });

    it('B 組織用 A 組織的案件 ID 建事件，與用不存在的案件 ID 得到相同的外鍵錯誤', async () => {
      const orgA = newUlid();
      const orgB = newUlid();
      const withTx = await env.prepare(orgA, orgB);
      const caseOfA = await withTx({ kind: 'org', orgId: orgA }, (tx) => ORG_TABLE_CASES['org.cases'].seed(tx, orgA));
      const addEvent = (caseId: string) =>
        outcome(() =>
          withTx({ kind: 'org', orgId: orgB }, (tx) =>
            tx.query(`INSERT INTO org.case_events (id, org_id, case_id, type, occurred_at) VALUES ($1, $2, $3, 'created', now())`, [
              newUlid(),
              orgB,
              caseId,
            ]),
          ),
        );
      const real = await addEvent(caseOfA);
      expect(real).toMatchObject({ ok: false, code: '23503' });
      expect(real).toEqual(await addEvent(newUlid()));
    });

    it('B 組織刪不到 A 組織被參照的案件，也不會因為被參照而收到外鍵錯誤', async () => {
      const orgA = newUlid();
      const orgB = newUlid();
      const withTx = await env.prepare(orgA, orgB);
      const memberId = await withTx({ kind: 'org', orgId: orgA }, (tx) => ORG_TABLE_CASES['org.case_members'].seed(tx, orgA));
      const caseId = await withTx({ kind: 'org', orgId: orgA }, async (tx) => (await tx.query<{ case_id: string }>('SELECT case_id FROM org.case_members WHERE id = $1', [memberId])).rows[0].case_id);
      // B 的 DELETE 在 RLS 下看不到 A 的案件，影響 0 列。看得到才會因被參照而丟外鍵錯誤，那就洩漏了
      const deleted = await withTx({ kind: 'org', orgId: orgB }, (tx) => tx.query('DELETE FROM org.cases WHERE id = $1 RETURNING id', [caseId]));
      expect(deleted.rows).toEqual([]);
    });
  });
}
