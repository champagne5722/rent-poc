import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bankAccount, depositAccount, rentIncomeAccount } from '../ledger';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { seedCases, testCaseId } from './test-cases';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-117：鏡像帳的表與觸發器。ADR-0015「實測結果」的 15 個情境轉成 migration 測試（寫入都從 app_rw 發出）。
// 這裡一律用原始 SQL 寫入，測的是資料庫自己的防線，不經過 ledger 模組的純函式。
// 情境 11（明細引用別的組織的科目）的轉換：科目是文字編碼，沒有科目表，所以改測「明細引用別的組織的分錄」，由複合外鍵擋下。
// 情境 15（承租人讀自己案件的列）的轉換：案件成員讀取政策在 MIL-123，這裡只測沒有組織脈絡時讀到 0 列。
// 每次 fresh() 都重新 SET ROLE app_rw，beforeEach 的控制組確認 current_user，避免 RLS 測試假通過（ADR-0012 Action Item 5）。

// 鏡像帳的 case_id 掛了 org.cases 的複合外鍵（MIL-123）：兩個組織各有 CASE1、CASE2 兩個案件
const CASE1 = testCaseId('CASE1');
const CASE2 = testCaseId('CASE2');
// org.cases.id 是全域唯一，所以組織 B 用自己的案件
const CASE_OF_B = testCaseId('CASEB1');
const BANK = bankAccount('PA1');
const DEPOSIT = depositAccount(CASE1);
const RENT = rentIncomeAccount(CASE1);

interface Line {
  account: string;
  debit?: number;
  credit?: number;
}

interface JournalSpec {
  orgId: string;
  id?: string;
  caseId?: string;
  eventType?: string;
  eventId?: string;
  reverses?: string | null;
  reason?: string | null;
  postedAt?: string;
  lines: Line[];
  /** 明細寫入時使用的案件，預設同分錄。用來測試明細與分錄的案件不同。 */
  entryCaseId?: string;
}

const balanced = (amount = 1000): Line[] => [
  { account: BANK, debit: amount },
  { account: DEPOSIT, credit: amount },
];

describe('鏡像帳的表與觸發器', () => {
  let testDb: TestDb;
  let db: PGliteInterface;
  let withTx: WithTx;
  const orgA = newUlid();
  const orgB = newUlid();

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());

  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', async () => {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]);
    });
    await seedCases(withTx, [orgA], [CASE1, CASE2]);
    await seedCases(withTx, [orgB], [CASE_OF_B]);
  });

  /** 沒指定案件時，每個組織寫自己的案件。 */
  const defaultCase = (orgId: string) => (orgId === orgB ? CASE_OF_B : CASE1);
  const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);

  async function insertJournalOnly(tx: OrgTx, spec: JournalSpec): Promise<string> {
    const id = spec.id ?? newUlid();
    await tx.query(
      `INSERT INTO org.ledger_journals
         (id, org_id, case_id, business_event_type, business_event_id, reverses_journal_id, reason, posted_at, effective_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()), '2026-11-08')`,
      [
        id,
        spec.orgId,
        spec.caseId ?? defaultCase(spec.orgId),
        spec.eventType ?? (spec.reverses ? 'reversal' : 'receipt_confirmed'),
        spec.eventId ?? newUlid(),
        spec.reverses ?? null,
        spec.reason ?? null,
        spec.postedAt ?? null,
      ],
    );
    return id;
  }

  async function insertEntries(tx: OrgTx, orgId: string, caseId: string, journalId: string, lines: Line[], startAt = 1): Promise<void> {
    let lineNo = startAt;
    for (const line of lines) {
      await tx.query(
        `INSERT INTO org.ledger_entries (id, org_id, case_id, journal_id, line_no, account, debit, credit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [newUlid(), orgId, caseId, journalId, lineNo++, line.account, line.debit ?? 0, line.credit ?? 0],
      );
    }
  }

  async function post(tx: OrgTx, spec: JournalSpec): Promise<string> {
    const id = await insertJournalOnly(tx, spec);
    await insertEntries(tx, spec.orgId, spec.entryCaseId ?? spec.caseId ?? defaultCase(spec.orgId), id, spec.lines);
    return id;
  }

  const postInOrg = (spec: JournalSpec) => inOrg(spec.orgId, (tx) => post(tx, spec));

  /** 在 postgres（超級使用者）身分執行，做完回到 app_rw。 */
  async function asSuperuser<T>(fn: () => Promise<T>): Promise<T> {
    await db.exec('RESET ROLE');
    try {
      return await fn();
    } finally {
      await db.exec('SET ROLE app_rw');
    }
  }

  /** 以組織 A 的身分數列數。沒有組織脈絡時 RLS 一律回 0，所以不能直接查。 */
  const count = async (table: string, orgId = orgA) =>
    (await inOrg(orgId, (tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM org.${table}`))).rows[0].n;

  describe('控制組：確認測試真的以 app_rw 身分、在 FORCE RLS 下執行', () => {
    it('current_user 是 app_rw，兩張表都 ENABLE 且 FORCE RLS', async () => {
      const user = await db.query<{ u: string }>('SELECT current_user AS u');
      expect(user.rows[0].u).toBe('app_rw');
      const { rows } = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relnamespace = 'org'::regnamespace AND relname IN ('ledger_journals', 'ledger_entries') ORDER BY relname`,
      );
      expect(rows).toEqual([
        { relname: 'ledger_entries', relrowsecurity: true, relforcerowsecurity: true },
        { relname: 'ledger_journals', relrowsecurity: true, relforcerowsecurity: true },
      ]);
    });

    it('app_rw 只有 SELECT 與 INSERT 權限', async () => {
      const { rows } = await db.query<{ t: string; priv: string; ok: boolean }>(
        `SELECT t, priv, has_table_privilege('app_rw', 'org.' || t, priv) AS ok
           FROM unnest(ARRAY['ledger_journals', 'ledger_entries']) AS t,
                unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS priv
          ORDER BY t, priv`,
      );
      const granted = rows.filter((r) => r.ok).map((r) => `${r.t}:${r.priv}`);
      expect(granted).toEqual(['ledger_entries:INSERT', 'ledger_entries:SELECT', 'ledger_journals:INSERT', 'ledger_journals:SELECT']);
    });
  });

  describe('ADR 情境 1：app_rw 寫平衡分錄，表設 FORCE', () => {
    it('成功，且讀得回來', async () => {
      const id = await postInOrg({ orgId: orgA, lines: balanced(1500) });
      const rows = await inOrg(orgA, (tx) =>
        tx.query<{ account: string; debit: string; credit: string }>(
          `SELECT account, debit::text, credit::text FROM org.ledger_entries WHERE journal_id = $1 ORDER BY line_no`,
          [id],
        ),
      );
      expect(rows.rows).toEqual([
        { account: BANK, debit: '1500', credit: '0' },
        { account: DEPOSIT, debit: '0', credit: '1500' },
      ]);
    });

    it('一筆分錄可以有三列以上（押金加租金）', async () => {
      await expect(
        postInOrg({
          orgId: orgA,
          lines: [{ account: BANK, debit: 3000 }, { account: DEPOSIT, credit: 2000 }, { account: RENT, credit: 1000 }],
        }),
      ).resolves.toBeTruthy();
    });
  });

  describe('ADR 情境 2、3：不平衡與沒有明細的分錄，提交時被擋', () => {
    it('借貸不等', async () => {
      await expect(
        postInOrg({ orgId: orgA, lines: [{ account: BANK, debit: 1000 }, { account: DEPOSIT, credit: 900 }] }),
      ).rejects.toThrow(/借貸不平衡/);
      expect(await count('ledger_journals')).toBe(0);
    });

    it('沒有任何明細', async () => {
      await expect(inOrg(orgA, (tx) => insertJournalOnly(tx, { orgId: orgA, lines: [] }))).rejects.toThrow(/至少 2 列/);
    });

    it('只有 1 列明細（單列不可能平衡，仍要被擋）', async () => {
      await expect(postInOrg({ orgId: orgA, lines: [{ account: BANK, debit: 0, credit: 1 }] })).rejects.toThrow(/至少 2 列/);
    });
  });

  describe('ADR 情境 4：對已提交的分錄追加一對平衡明細', () => {
    it('被 posted_txid 擋下', async () => {
      const id = await postInOrg({ orgId: orgA, lines: balanced() });
      await expect(
        inOrg(orgA, (tx) => insertEntries(tx, orgA, CASE1, id, [{ account: BANK, debit: 5 }, { account: DEPOSIT, credit: 5 }], 3)),
      ).rejects.toThrow(/不同交易/);
      expect(await count('ledger_entries')).toBe(2);
    });

    it('同一交易內分次追加明細是允許的', async () => {
      await expect(
        inOrg(orgA, async (tx) => {
          const id = await insertJournalOnly(tx, { orgId: orgA, lines: [] });
          await insertEntries(tx, orgA, CASE1, id, [{ account: BANK, debit: 7 }]);
          await insertEntries(tx, orgA, CASE1, id, [{ account: DEPOSIT, credit: 7 }], 2);
        }),
      ).resolves.toBeUndefined();
    });

    it('呼叫端自填 posted_txid 也沒用，觸發器一律覆寫成目前交易', async () => {
      const id = await inOrg(orgA, async (tx) => {
        const journalId = newUlid();
        await tx.query(
          `INSERT INTO org.ledger_journals (id, org_id, case_id, business_event_type, business_event_id, effective_date, posted_txid)
           VALUES ($1, $2, $4, 'receipt_confirmed', $3, '2026-11-08', 1)`,
          [journalId, orgA, newUlid(), CASE1],
        );
        await insertEntries(tx, orgA, CASE1, journalId, balanced());
        return journalId;
      });
      await expect(
        inOrg(orgA, (tx) => insertEntries(tx, orgA, CASE1, id, [{ account: BANK, debit: 5 }, { account: DEPOSIT, credit: 5 }], 3)),
      ).rejects.toThrow(/不同交易/);
    });
  });

  describe('ADR 情境 5、6：UPDATE、DELETE、TRUNCATE', () => {
    let id: string;
    beforeEach(async () => {
      id = await postInOrg({ orgId: orgA, lines: balanced() });
    });
    const statements = [
      ['ledger_journals', `UPDATE org.ledger_journals SET case_id = 'X'`],
      ['ledger_journals', 'DELETE FROM org.ledger_journals'],
      ['ledger_journals', 'TRUNCATE org.ledger_journals, org.ledger_entries'],
      ['ledger_entries', 'UPDATE org.ledger_entries SET debit = debit + 1'],
      ['ledger_entries', 'DELETE FROM org.ledger_entries'],
      ['ledger_entries', 'TRUNCATE org.ledger_entries'],
    ] as const;

    it.each(statements)('app_rw 對 %s 執行「%s」：permission denied', async (_table, sql) => {
      await expect(inOrg(orgA, (tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
    });

    it.each(statements)('超級使用者對 %s 執行「%s」：觸發器擋下', async (_table, sql) => {
      await asSuperuser(async () => {
        await expect(db.query(sql)).rejects.toThrow(/只增不改/);
      });
    });

    it('app_owner 的 TRUNCATE 被觸發器擋下', async () => {
      await asRole(db, 'app_owner', async () => {
        await expect(db.query('TRUNCATE org.ledger_entries')).rejects.toThrow(/只增不改/);
        // 單獨 TRUNCATE 被參照的 ledger_journals 會先被外鍵擋下，兩張表一起 TRUNCATE 才走到觸發器
        await expect(db.query('TRUNCATE org.ledger_journals, org.ledger_entries')).rejects.toThrow(/只增不改/);
        await expect(db.query('TRUNCATE org.ledger_journals')).rejects.toThrow(/truncate|只增不改/);
      });
    });

    it('app_owner 的 UPDATE 與 DELETE 在 FORCE RLS 下影響 0 列，資料不變', async () => {
      await asRole(db, 'app_owner', async () => {
        expect((await db.query(`UPDATE org.ledger_entries SET debit = debit + 1 RETURNING id`)).rows).toEqual([]);
        expect((await db.query(`DELETE FROM org.ledger_journals RETURNING id`)).rows).toEqual([]);
      });
      const rows = await inOrg(orgA, (tx) => tx.query<{ debit: string }>(`SELECT debit::text FROM org.ledger_entries WHERE journal_id = $1 ORDER BY line_no`, [id]));
      expect(rows.rows).toEqual([{ debit: '1000' }, { debit: '0' }]);
    });
  });

  describe('ADR 情境 7、8：沖銷（第二次沖銷、金額不對映），加上沖銷的其他前提', () => {
    const reversalOf = (orgId: string, original: string, lines: Line[], over: Partial<JournalSpec> = {}): JournalSpec => ({
      orgId,
      reverses: original,
      reason: '登錯',
      lines,
      ...over,
    });
    const opposite: Line[] = [{ account: DEPOSIT, debit: 1000 }, { account: BANK, credit: 1000 }];

    it('借貸相反的沖銷可以寫入', async () => {
      const original = await postInOrg({ orgId: orgA, lines: balanced() });
      await expect(postInOrg(reversalOf(orgA, original, opposite))).resolves.toBeTruthy();
    });

    it('同一筆分錄第二次沖銷：唯一鍵擋下', async () => {
      const original = await postInOrg({ orgId: orgA, lines: balanced() });
      await postInOrg(reversalOf(orgA, original, opposite));
      await expect(postInOrg(reversalOf(orgA, original, opposite))).rejects.toThrow(/unique|duplicate/i);
    });

    it('金額不對映的沖銷：觸發器擋下', async () => {
      const original = await postInOrg({ orgId: orgA, lines: balanced() });
      await expect(
        postInOrg(reversalOf(orgA, original, [{ account: DEPOSIT, debit: 900 }, { account: BANK, credit: 900 }])),
      ).rejects.toThrow(/沖銷.*不相反/);
    });

    it('借貸沒有互換（方向一樣）：觸發器擋下', async () => {
      const original = await postInOrg({ orgId: orgA, lines: balanced() });
      await expect(postInOrg(reversalOf(orgA, original, balanced()))).rejects.toThrow(/沖銷.*不相反/);
    });

    it('雙向比對：沖銷少一列、多一列都擋下', async () => {
      const three: Line[] = [{ account: BANK, debit: 3000 }, { account: DEPOSIT, credit: 2000 }, { account: RENT, credit: 1000 }];
      const original = await postInOrg({ orgId: orgA, lines: three });
      // 少一列：貸方 2000 + 借方 3000... 把租金那列併進押金，合計仍平衡但列數不同
      await expect(
        postInOrg(reversalOf(orgA, original, [{ account: DEPOSIT, debit: 3000 }, { account: BANK, credit: 3000 }])),
      ).rejects.toThrow(/沖銷.*不相反/);
      // 多一列：原分錄兩列，沖銷拆成三列
      const two = await postInOrg({ orgId: orgA, lines: balanced(3000) });
      await expect(
        postInOrg(
          reversalOf(orgA, two, [
            { account: DEPOSIT, debit: 2000 },
            { account: DEPOSIT, debit: 1000 },
            { account: BANK, credit: 3000 },
          ]),
        ),
      ).rejects.toThrow(/沖銷.*不相反/);
      // 正確的三列沖銷可以
      await expect(
        postInOrg(reversalOf(orgA, original, [{ account: DEPOSIT, debit: 2000 }, { account: RENT, debit: 1000 }, { account: BANK, credit: 3000 }])),
      ).resolves.toBeTruthy();
    });

    it('只沖銷原分錄的一部分（沖銷是原分錄相反明細的子集且自己平衡）：第二個方向的比對擋下', async () => {
      const four: Line[] = [
        { account: BANK, debit: 100 },
        { account: DEPOSIT, debit: 200 },
        { account: RENT, credit: 100 },
        { account: depositAccount('CASE9'), credit: 200 },
      ];
      const original = await postInOrg({ orgId: orgA, caseId: CASE1, lines: four });
      // 只反轉第二與第四列：自己平衡，也完全落在「原分錄相反明細」之內，只有反方向比對抓得到少了兩列
      await expect(
        postInOrg(reversalOf(orgA, original, [{ account: DEPOSIT, credit: 200 }, { account: depositAccount('CASE9'), debit: 200 }])),
      ).rejects.toThrow(/沖銷.*不相反/);
    });

    it('不得沖銷沖銷分錄', async () => {
      const original = await postInOrg({ orgId: orgA, lines: balanced() });
      const reversal = await postInOrg(reversalOf(orgA, original, opposite));
      await expect(postInOrg(reversalOf(orgA, reversal, balanced()))).rejects.toThrow(/不得沖銷沖銷分錄/);
    });

    it('沖銷必須有原因：缺原因、空白原因都擋下', async () => {
      const original = await postInOrg({ orgId: orgA, lines: balanced() });
      await expect(postInOrg(reversalOf(orgA, original, opposite, { reason: null }))).rejects.toThrow(/check constraint/i);
      await expect(postInOrg(reversalOf(orgA, original, opposite, { reason: '   ' }))).rejects.toThrow(/check constraint/i);
    });

    it('一般分錄不得帶原因；沖銷的事件類型必須是 reversal', async () => {
      const original = await postInOrg({ orgId: orgA, lines: balanced() });
      await expect(postInOrg({ orgId: orgA, reason: '不該有', lines: balanced() })).rejects.toThrow(/check constraint/i);
      await expect(postInOrg(reversalOf(orgA, original, opposite, { eventType: 'receipt_confirmed' }))).rejects.toThrow(/check constraint/i);
      await expect(postInOrg({ orgId: orgA, eventType: 'reversal', lines: balanced() })).rejects.toThrow(/check constraint/i);
    });

    it('沖銷的案件必須與原分錄相同', async () => {
      const original = await postInOrg({ orgId: orgA, caseId: CASE1, lines: balanced() });
      await expect(
        postInOrg(reversalOf(orgA, original, opposite, { caseId: CASE2, entryCaseId: CASE2 })),
      ).rejects.toThrow(/案件/);
    });

    it('不能沖銷不存在的分錄，也不能沖銷別的組織的分錄', async () => {
      const bJournal = await postInOrg({ orgId: orgB, lines: balanced() });
      await expect(postInOrg(reversalOf(orgA, newUlid(), opposite))).rejects.toThrow(/foreign key|violates|不存在/i);
      await expect(postInOrg(reversalOf(orgA, bJournal, opposite))).rejects.toThrow(/foreign key|violates|不存在/i);
    });
  });

  describe('ADR 情境 9：沖銷後用同一業務事件 ID 再寫分錄', () => {
    it('唯一鍵擋下', async () => {
      const eventId = 'EVENT-1';
      const original = await postInOrg({ orgId: orgA, eventId, lines: balanced() });
      await postInOrg({ orgId: orgA, reverses: original, reason: '登錯', lines: [{ account: DEPOSIT, debit: 1000 }, { account: BANK, credit: 1000 }] });
      await expect(postInOrg({ orgId: orgA, eventId, lines: balanced() })).rejects.toThrow(/unique|duplicate/i);
    });
  });

  describe('ADR 情境 10、11、12：跨組織與案件', () => {
    it('A 組織脈絡寫 B 組織的分錄：RLS 擋下', async () => {
      await expect(inOrg(orgA, (tx) => post(tx, { orgId: orgB, lines: balanced() }))).rejects.toThrow(/row-level security/);
    });

    it('A 組織的明細引用 B 組織的分錄：複合外鍵擋下（外鍵不受 RLS 限制）', async () => {
      const bJournal = await postInOrg({ orgId: orgB, lines: balanced() });
      // 在 B 的脈絡下追加，org_id 寫 A：RLS 擋；在 A 的脈絡下寫 A 的 org_id 引用 B 的分錄：外鍵擋
      await expect(
        inOrg(orgA, (tx) => insertEntries(tx, orgA, CASE1, bJournal, [{ account: BANK, debit: 1 }, { account: DEPOSIT, credit: 1 }])),
      ).rejects.toThrow(/不同交易|foreign key|violates/i);
    });

    it('明細的案件與分錄的案件不同：複合外鍵擋下', async () => {
      await expect(postInOrg({ orgId: orgA, caseId: CASE1, entryCaseId: CASE2, lines: balanced() })).rejects.toThrow(
        /foreign key|violates/i,
      );
    });
  });

  describe('ADR 情境 13：不平衡分錄，提交前切換 app.org_id', () => {
    const switchTo = (tx: OrgTx, orgId: string) => tx.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);

    it('不平衡分錄切換組織脈絡後仍被擋下', async () => {
      await expect(
        inOrg(orgA, async (tx) => {
          await post(tx, { orgId: orgA, lines: [{ account: BANK, debit: 1000 }, { account: DEPOSIT, credit: 1 }] });
          await switchTo(tx, orgB);
        }),
      ).rejects.toThrow(/組織脈絡/);
      expect(await count('ledger_journals')).toBe(0);
    });

    it('平衡分錄切換到別的組織或清空脈絡也被擋下（證明擋下的是脈絡切換）', async () => {
      await expect(
        inOrg(orgA, async (tx) => {
          await post(tx, { orgId: orgA, lines: balanced() });
          await switchTo(tx, orgB);
        }),
      ).rejects.toThrow(/組織脈絡/);
      await expect(
        inOrg(orgA, async (tx) => {
          await post(tx, { orgId: orgA, lines: balanced() });
          await switchTo(tx, '');
        }),
      ).rejects.toThrow(/組織脈絡/);
    });

    it('切換後在提交前切回原組織，照常提交', async () => {
      await expect(
        inOrg(orgA, async (tx) => {
          await post(tx, { orgId: orgA, lines: balanced() });
          await switchTo(tx, orgB);
          await switchTo(tx, orgA);
        }),
      ).resolves.toBeUndefined();
      expect(await count('ledger_journals')).toBe(1);
    });
  });

  describe('ADR 情境 14：別的組織用相同業務事件鍵', () => {
    it('成功；同一組織重複則失敗', async () => {
      await postInOrg({ orgId: orgA, eventId: 'SAME', lines: balanced() });
      await expect(postInOrg({ orgId: orgB, eventId: 'SAME', lines: balanced() })).resolves.toBeTruthy();
      await expect(postInOrg({ orgId: orgA, eventId: 'SAME', lines: balanced() })).rejects.toThrow(/unique|duplicate/i);
    });
  });

  describe('ADR 情境 15：沒有組織脈絡時讀不到', () => {
    it('control 脈絡與 party 脈絡一律 0 列（案件成員讀取政策在 MIL-123 加入）', async () => {
      await postInOrg({ orgId: orgA, lines: balanced() });
      for (const table of ['ledger_journals', 'ledger_entries']) {
        const control = await withTx({ kind: 'control' }, (tx) => tx.query(`SELECT count(*)::int AS n FROM org.${table}`));
        expect(control.rows).toEqual([{ n: 0 }]);
        const party = await withTx({ kind: 'party', partyId: newUlid() }, (tx) => tx.query(`SELECT count(*)::int AS n FROM org.${table}`));
        expect(party.rows).toEqual([{ n: 0 }]);
        const other = await inOrg(orgB, (tx) => tx.query(`SELECT count(*)::int AS n FROM org.${table}`));
        expect(other.rows).toEqual([{ n: 0 }]);
      }
    });
  });

  describe('金額與欄位的 CHECK', () => {
    const MAX_SAFE = Number.MAX_SAFE_INTEGER;
    const lineOf = (debit: number, credit: number): Line[] => [{ account: BANK, debit, credit }, { account: DEPOSIT, credit: 1 }];

    it('負數被擋下', async () => {
      await expect(postInOrg({ orgId: orgA, lines: lineOf(-5, 0) })).rejects.toThrow(/check constraint/i);
      await expect(postInOrg({ orgId: orgA, lines: [{ account: BANK, debit: 1 }, { account: DEPOSIT, credit: -1 }] })).rejects.toThrow(
        /check constraint/i,
      );
    });

    it('一列借貸都大於 0 或都是 0 被擋下', async () => {
      await expect(postInOrg({ orgId: orgA, lines: lineOf(5, 5) })).rejects.toThrow(/check constraint/i);
      await expect(postInOrg({ orgId: orgA, lines: lineOf(0, 0) })).rejects.toThrow(/check constraint/i);
    });

    it('金額超過安全整數被擋下，剛好是安全整數上限可以', async () => {
      await expect(postInOrg({ orgId: orgA, lines: balanced(MAX_SAFE) })).resolves.toBeTruthy();
      await db.exec('SET ROLE app_rw'); // 上一個交易已結束，確認身分沒變
      await expect(
        inOrg(orgA, async (tx) => {
          const id = await insertJournalOnly(tx, { orgId: orgA, lines: [] });
          await tx.query(
            `INSERT INTO org.ledger_entries (id, org_id, case_id, journal_id, line_no, account, debit, credit)
             VALUES ($1, $2, $5, $3, 1, $4, 9007199254740992, 0)`,
            [newUlid(), orgA, id, BANK, CASE1],
          );
        }),
      ).rejects.toThrow(/check constraint/i);
    });

    it('科目編碼格式不對被擋下', async () => {
      for (const account of ['bank.PA1', 'asset.bank', 'expense.rent.X', 'asset.bank.has.dot', 'asset.Bank.X', '']) {
        await expect(
          postInOrg({ orgId: orgA, lines: [{ account, debit: 1 }, { account: DEPOSIT, credit: 1 }] }),
          account,
        ).rejects.toThrow(/check constraint/i);
      }
    });

    it('同一分錄的 line_no 不得重複', async () => {
      await expect(
        inOrg(orgA, async (tx) => {
          const id = await insertJournalOnly(tx, { orgId: orgA, lines: [] });
          await insertEntries(tx, orgA, CASE1, id, [{ account: BANK, debit: 1 }], 1);
          await insertEntries(tx, orgA, CASE1, id, [{ account: DEPOSIT, credit: 1 }], 1);
        }),
      ).rejects.toThrow(/unique|duplicate/i);
    });

    it('案件 ID、事件類型、業務事件 ID 的格式檢查', async () => {
      await expect(postInOrg({ orgId: orgA, caseId: 'has space', lines: balanced() })).rejects.toThrow(/check constraint/i);
      await expect(postInOrg({ orgId: orgA, eventType: 'Bad-Type', lines: balanced() })).rejects.toThrow(/check constraint/i);
      await expect(postInOrg({ orgId: orgA, eventId: 'x'.repeat(65), lines: balanced() })).rejects.toThrow(/check constraint/i);
    });
  });

  describe('事件類型是開放字串', () => {
    it('資料庫不認得事件清單，其他線新增的事件類型不必改 migration', async () => {
      await expect(postInOrg({ orgId: orgA, eventType: 'handover_released', lines: balanced() })).resolves.toBeTruthy();
      await expect(postInOrg({ orgId: orgA, eventType: 'test_any_new_event', lines: balanced() })).resolves.toBeTruthy();
    });
  });
});
