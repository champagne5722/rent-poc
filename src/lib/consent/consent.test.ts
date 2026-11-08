import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestDb } from '../pg/test-harness';
import {
  ORG_A,
  ORG_B,
  OPERATOR_X,
  PARTY_P,
  asSuperuser,
  createTestDb,
  openFixture,
  orgCtx,
  type AuditFixture,
} from '../audit/audit-test-kit';
import { verifyChain } from '../audit';
import { createConsentApi, latestConsent, recordConsent, type RecordConsentInput } from './consent';
import { NOTICE_CATALOG, currentNotice, textSha256, type NoticeCatalog } from './notices';

// MIL-84：告知與同意紀錄。seam 有三個：
// - recordConsent／latestConsent（TypeScript 入口）。
// - app_rw 對 org.consent_records 的直接存取（權限、RLS、觸發器）。
// - audit.events：同交易寫入的稽核事件。
// 每個測試的連線身分都是 app_rw（harness 的 fresh()），所以 RLS 與權限的結果是真的。

const PARTY_Q = '01JBKQ0000000000000000000Q';
const CONTRACT_1 = '01JBKQ00000000000000000C01';

const base: RecordConsentInput = {
  notice: 'esign',
  subject: { email: 'tenant@example.com' },
  decision: 'agree',
  source: 'email_link',
};

describe('告知與同意紀錄', () => {
  let testDb: TestDb;
  let f: AuditFixture;
  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    f = await openFixture(testDb);
  });
  afterEach(() => f.close());

  interface Row {
    id: string;
    org_id: string;
    notice_type: string;
    notice_version: number;
    text_sha256: string;
    subject_party_id: string | null;
    subject_email: string | null;
    decision: string;
    source: string;
    related_type: string | null;
    related_id: string | null;
    audit_chain_id: string;
    audit_seq: string;
  }
  const rowsOf = (ctx: Parameters<typeof f.withTx>[0]) =>
    f.withTx(ctx, async (tx) => (await tx.query<Row>('SELECT *, audit_seq::text AS audit_seq FROM org.consent_records ORDER BY seq')).rows);
  const auditActions = (ctx: Parameters<typeof f.withTx>[0]) =>
    f.withTx(ctx, async (tx) => (await tx.query<{ action: string }>('SELECT action FROM audit.events ORDER BY seq')).rows.map((r) => r.action));

  describe('recordConsent：寫入的欄位（AC4）', () => {
    it('記錄類型、版本、文字雜湊、對象、決定、時間、來源與關聯標的', async () => {
      const rec = await f.withTx(orgCtx(ORG_A), (tx) =>
        recordConsent(tx, { ...base, subject: { partyId: PARTY_P, email: 'Tenant@Example.com ' }, relatedTo: { type: 'contract', id: CONTRACT_1 } }),
      );
      const [row] = await rowsOf(orgCtx(ORG_A));
      expect(row).toMatchObject({
        id: rec.id,
        org_id: ORG_A,
        notice_type: 'esign',
        notice_version: 1,
        text_sha256: textSha256(NOTICE_CATALOG.esign[0].text),
        subject_party_id: PARTY_P,
        subject_email: 'tenant@example.com',
        decision: 'agree',
        source: 'email_link',
        related_type: 'contract',
        related_id: CONTRACT_1,
        audit_chain_id: ORG_A,
      });
      expect(rec).toMatchObject({
        orgId: ORG_A,
        noticeType: 'esign',
        noticeVersion: 1,
        decision: 'agree',
        source: 'email_link',
        subject: { partyId: PARTY_P, email: 'tenant@example.com' },
        relatedTo: { type: 'contract', id: CONTRACT_1 },
      });
      expect(rec.recordedAt).toBeInstanceOf(Date);
      expect(Math.abs(rec.recordedAt.getTime() - Date.now())).toBeLessThan(60_000);
    });

    it('關聯標的選填，沒填時欄位為空', async () => {
      await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, base));
      const [row] = await rowsOf(orgCtx(ORG_A));
      expect([row.related_type, row.related_id]).toEqual([null, null]);
    });

    it('四種告知類型都能記錄，反對也能記錄', async () => {
      for (const notice of ['esign', 'transcript_id_pii', 'certificate_pii', 'case_data_sharing'] as const) {
        await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, { ...base, notice, decision: 'object' }));
      }
      const rows = await rowsOf(orgCtx(ORG_A));
      expect(rows.map((r) => r.notice_type)).toEqual(['esign', 'transcript_id_pii', 'certificate_pii', 'case_data_sharing']);
      expect(new Set(rows.map((r) => r.decision))).toEqual(new Set(['object']));
    });

    it('拒絕不合法的輸入：決定、來源、告知類型、關聯標的格式', async () => {
      const bad: Array<[string, Partial<RecordConsentInput>]> = [
        ['決定', { decision: 'maybe' as never }],
        ['來源', { source: 'sms' as never }],
        ['告知類型', { notice: 'unknown' as never }],
        ['關聯類型含大寫', { relatedTo: { type: 'Contract', id: 'x' } }],
        ['關聯 ID 為空', { relatedTo: { type: 'contract', id: '' } }],
        ['關聯 ID 超過 64 字', { relatedTo: { type: 'contract', id: 'x'.repeat(65) } }],
      ];
      for (const [name, patch] of bad) {
        await expect(f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, { ...base, ...patch })), name).rejects.toThrow();
      }
      expect(await rowsOf(orgCtx(ORG_A))).toEqual([]);
    });
  });

  describe('對象識別（AC5）', () => {
    it('沒有 party ID 也沒有 email 時拒絕', async () => {
      await expect(f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, { ...base, subject: {} }))).rejects.toThrow(/party ID 或 email/);
    });

    it('空字串、全空白的 email 與空的 party ID 視為沒有', async () => {
      for (const subject of [{ email: '' }, { email: '   ' }, { partyId: '' }, { partyId: '', email: ' ' }]) {
        await expect(f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, { ...base, subject }))).rejects.toThrow(/party ID 或 email/);
      }
    });

    it('格式不合法的 party ID 或 email 拒絕', async () => {
      await expect(f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, { ...base, subject: { partyId: 'not-a-ulid' } }))).rejects.toThrow(/party ID/);
      for (const email of ['no-at-sign', 'a@b@c', 'sp ace@example.com', `${'a'.repeat(250)}@example.com`]) {
        await expect(f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, { ...base, subject: { email } }))).rejects.toThrow(/email/);
      }
    });

    it('資料庫端也擋：直接 INSERT 沒有對象的列被 CHECK 拒絕', async () => {
      await expect(
        f.withTx(orgCtx(ORG_A), (tx) =>
          tx.query(
            `INSERT INTO org.consent_records (id, org_id, notice_type, notice_version, text_sha256, decision, source, audit_chain_id, audit_seq)
             VALUES ('01JBKQ00000000000000000Z01', $1, 'esign', 1, repeat('a', 64), 'agree', 'in_app', $1, 1)`,
            [ORG_A],
          ),
        ),
      ).rejects.toThrow(/consent_subject_present/);
    });
  });

  describe('同交易寫稽核事件（AC6）', () => {
    it('寫一筆 consent.record，紀錄存下事件位置，鏈驗證通過', async () => {
      const rec = await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, { ...base, relatedTo: { type: 'contract', id: CONTRACT_1 } }));
      expect(await auditActions(orgCtx(ORG_A))).toEqual(['consent.record']);
      expect(rec.audit.chainId).toBe(ORG_A);
      expect(rec.audit.seq).toBe(1);
      const [row] = await rowsOf(orgCtx(ORG_A));
      expect([row.audit_chain_id, Number(row.audit_seq)]).toEqual([ORG_A, 1]);
      const report = await f.withTx(orgCtx(ORG_A), (tx) => verifyChain(tx));
      expect(report.ok).toBe(true);
    });

    it('稽核事件的物件是這筆同意紀錄，payload 有類型、版本、雜湊、決定與來源，沒有 email 與 party ID', async () => {
      const rec = await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, { ...base, subject: { partyId: PARTY_P, email: 'tenant@example.com' } }));
      const ev = await f.withTx(orgCtx(ORG_A), async (tx) =>
        (await tx.query<{ object_type: string; object_id: string; payload: Record<string, unknown>; canonical: string }>('SELECT object_type, object_id, payload, canonical FROM audit.events')).rows[0],
      );
      expect(ev.object_type).toBe('consent_record');
      expect(ev.object_id).toBe(rec.id);
      expect(ev.payload).toEqual({
        notice_type: 'esign',
        notice_version: 1,
        text_sha256: textSha256(NOTICE_CATALOG.esign[0].text),
        decision: 'agree',
        source: 'email_link',
      });
      expect(ev.canonical).not.toContain('tenant@example.com');
      expect(ev.canonical).not.toContain(PARTY_P);
    });

    it('交易回滾時，同意紀錄與稽核事件都不留下', async () => {
      await expect(
        f.withTx(orgCtx(ORG_A), async (tx) => {
          await recordConsent(tx, base);
          throw new Error('後續步驟失敗');
        }),
      ).rejects.toThrow('後續步驟失敗');
      expect(await rowsOf(orgCtx(ORG_A))).toEqual([]);
      expect(await auditActions(orgCtx(ORG_A))).toEqual([]);
      // 序號沒有被回滾的交易推進
      const next = await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, base));
      expect(next.audit.seq).toBe(1);
    });

    it('寫入同意紀錄失敗時，同一交易內先寫的稽核事件也一起回滾', async () => {
      // 兩個 ORG 的 id 撞到主鍵：用同一個 id 寫第二次，稽核事件已先 append，INSERT 才失敗
      const api = createConsentApi(NOTICE_CATALOG, { newId: () => '01JBKQ00000000000000000Z02' });
      await f.withTx(orgCtx(ORG_A), (tx) => api.recordConsent(tx, base));
      await expect(f.withTx(orgCtx(ORG_A), (tx) => api.recordConsent(tx, base))).rejects.toThrow(/duplicate key|unique/i);
      expect(await auditActions(orgCtx(ORG_A))).toEqual(['consent.record']);
      expect(await rowsOf(orgCtx(ORG_A))).toHaveLength(1);
    });

    it('在 operator 脈絡寫入：稽核行為者是營運者，同意紀錄屬於目標組織', async () => {
      const ctx = { kind: 'operator', operatorId: OPERATOR_X, orgId: ORG_A, ticketId: 'T-1' } as const;
      const rec = await f.withTx(ctx, (tx) => recordConsent(tx, { ...base, source: 'staff_recorded' }));
      expect(rec.orgId).toBe(ORG_A);
      const actors = await f.withTx(orgCtx(ORG_A), async (tx) =>
        (await tx.query<{ action: string; actor_type: string }>('SELECT action, actor_type FROM audit.events ORDER BY seq')).rows,
      );
      expect(actors).toEqual([
        { action: 'operator.access', actor_type: 'operator' },
        { action: 'consent.record', actor_type: 'operator' },
      ]);
    });
  });

  describe('脈絡限制', () => {
    it('control 與 party 脈絡執行期拒絕', async () => {
      await expect(f.withTx({ kind: 'control' }, (tx) => recordConsent(tx as never, base))).rejects.toThrow(/組織脈絡/);
      await expect(f.withTx({ kind: 'party', partyId: PARTY_P }, (tx) => recordConsent(tx as never, base))).rejects.toThrow(/組織脈絡/);
      await expect(f.withTx({ kind: 'control' }, (tx) => latestConsent(tx as never, { notice: 'esign', subject: { partyId: PARTY_P } }))).rejects.toThrow(/組織脈絡/);
    });

    it('control 與 party 脈絡的 tx 傳進來，tsc 報錯', async () => {
      // 這個測試的價值在 tsc：@ts-expect-error 若不再報錯，tsc 會失敗
      const check = async () => {
        await f.withTx({ kind: 'control' }, (tx) =>
          // @ts-expect-error control 脈絡的 tx 不是 OrgTx
          recordConsent(tx, base),
        );
      };
      await expect(check()).rejects.toThrow();
    });
  });

  describe('文字改版（AC7，P0-24 AC4）', () => {
    const v1 = NOTICE_CATALOG.esign[0];
    const bumped: NoticeCatalog = {
      ...NOTICE_CATALOG,
      esign: [v1, { version: 2, title: '電子簽署告知', text: '第二版的文字', legalReview: 'approved' }],
    };

    it('改版後新紀錄用新版本與新文字的雜湊，舊紀錄保留原版本', async () => {
      const before = createConsentApi(NOTICE_CATALOG);
      const after = createConsentApi(bumped);
      await f.withTx(orgCtx(ORG_A), (tx) => before.recordConsent(tx, base));
      await f.withTx(orgCtx(ORG_A), (tx) => after.recordConsent(tx, base));
      const rows = await rowsOf(orgCtx(ORG_A));
      expect(rows.map((r) => r.notice_version)).toEqual([1, 2]);
      expect(rows[0].text_sha256).toBe(textSha256(v1.text));
      expect(rows[1].text_sha256).toBe(textSha256('第二版的文字'));
      expect(rows[0].text_sha256).not.toBe(rows[1].text_sha256);
    });

    it('指定版本時記錄那一版，例如對象看到的是寄出時的舊版', async () => {
      const after = createConsentApi(bumped);
      const rec = await f.withTx(orgCtx(ORG_A), (tx) => after.recordConsent(tx, { ...base, version: 1 }));
      expect(rec.noticeVersion).toBe(1);
      expect(rec.textSha256).toBe(textSha256(v1.text));
    });

    it('指定不存在的版本拒絕', async () => {
      const after = createConsentApi(bumped);
      for (const version of [0, 3, 1.5, -1]) {
        await expect(f.withTx(orgCtx(ORG_A), (tx) => after.recordConsent(tx, { ...base, version }))).rejects.toThrow(/版本/);
      }
    });

    it('預設用目前版本', async () => {
      const rec = await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, base));
      expect(rec.noticeVersion).toBe(currentNotice(NOTICE_CATALOG, 'esign').version);
    });
  });

  describe('latestConsent（AC8）', () => {
    const q = { notice: 'esign', subject: { email: 'tenant@example.com' } } as const;

    it('沒有紀錄時回傳 null', async () => {
      expect(await f.withTx(orgCtx(ORG_A), (tx) => latestConsent(tx, q))).toBeNull();
    });

    it('回傳最新的決定與版本：先同意後反對，最新是反對', async () => {
      await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, base));
      await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, { ...base, decision: 'object' }));
      const latest = await f.withTx(orgCtx(ORG_A), (tx) => latestConsent(tx, q));
      expect(latest).toMatchObject({ decision: 'object', noticeVersion: 1, noticeType: 'esign' });
    });

    it('同一個交易內連續寫入，最新仍然是後寫的那一筆', async () => {
      const latest = await f.withTx(orgCtx(ORG_A), async (tx) => {
        await recordConsent(tx, { ...base, decision: 'object' });
        await recordConsent(tx, base);
        return latestConsent(tx, q);
      });
      expect(latest?.decision).toBe('agree');
    });

    it('改版後：舊版的同意仍是最新決定，但標示不是目前版本；新版同意後標示為目前版本', async () => {
      const v1 = NOTICE_CATALOG.esign[0];
      const bumped: NoticeCatalog = { ...NOTICE_CATALOG, esign: [v1, { version: 2, title: 't', text: '第二版', legalReview: 'approved' }] };
      const before = createConsentApi(NOTICE_CATALOG);
      const after = createConsentApi(bumped);
      await f.withTx(orgCtx(ORG_A), (tx) => before.recordConsent(tx, base));
      const stale = await f.withTx(orgCtx(ORG_A), (tx) => after.latestConsent(tx, q));
      expect(stale).toMatchObject({ decision: 'agree', noticeVersion: 1, isCurrentVersion: false });
      await f.withTx(orgCtx(ORG_A), (tx) => after.recordConsent(tx, base));
      const fresh = await f.withTx(orgCtx(ORG_A), (tx) => after.latestConsent(tx, q));
      expect(fresh).toMatchObject({ decision: 'agree', noticeVersion: 2, isCurrentVersion: true });
    });

    it('依告知類型區分', async () => {
      await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, base));
      expect(await f.withTx(orgCtx(ORG_A), (tx) => latestConsent(tx, { ...q, notice: 'certificate_pii' }))).toBeNull();
    });

    it('依對象區分，partyId 或 email 任一相符就算同一對象，email 不分大小寫', async () => {
      await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, { ...base, subject: { partyId: PARTY_P } }));
      await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, { ...base, decision: 'object', subject: { email: 'other@example.com' } }));
      const byParty = await f.withTx(orgCtx(ORG_A), (tx) => latestConsent(tx, { notice: 'esign', subject: { partyId: PARTY_P } }));
      expect(byParty?.decision).toBe('agree');
      const byEither = await f.withTx(orgCtx(ORG_A), (tx) => latestConsent(tx, { notice: 'esign', subject: { partyId: PARTY_P, email: 'OTHER@example.com' } }));
      expect(byEither?.decision).toBe('object'); // 兩筆都相符，取最新
      expect(await f.withTx(orgCtx(ORG_A), (tx) => latestConsent(tx, { notice: 'esign', subject: { partyId: PARTY_Q } }))).toBeNull();
    });

    it('沒有對象時拒絕查詢，不會回傳別人的紀錄', async () => {
      await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, base));
      await expect(f.withTx(orgCtx(ORG_A), (tx) => latestConsent(tx, { notice: 'esign', subject: {} }))).rejects.toThrow(/party ID 或 email/);
    });

    it('指定關聯標的時只看該標的的紀錄', async () => {
      await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, { ...base, relatedTo: { type: 'contract', id: CONTRACT_1 } }));
      await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, { ...base, decision: 'object', relatedTo: { type: 'contract', id: 'other' } }));
      const one = await f.withTx(orgCtx(ORG_A), (tx) => latestConsent(tx, { ...q, relatedTo: { type: 'contract', id: CONTRACT_1 } }));
      expect(one?.decision).toBe('agree');
      expect(one?.relatedTo).toEqual({ type: 'contract', id: CONTRACT_1 });
      const any = await f.withTx(orgCtx(ORG_A), (tx) => latestConsent(tx, q));
      expect(any?.decision).toBe('object');
    });

    it('看不到其他組織的紀錄', async () => {
      await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, base));
      expect(await f.withTx(orgCtx(ORG_B), (tx) => latestConsent(tx, q))).toBeNull();
    });
  });

  describe('資料表的權限、RLS 與滲透案例（AC2、AC3、AC9）', () => {
    beforeEach(async () => {
      await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, base));
      await f.withTx(orgCtx(ORG_B), (tx) => recordConsent(tx, { ...base, subject: { email: 'b@example.com' } }));
    });

    it('ENABLE 與 FORCE RLS，有 org_id 欄位', async () => {
      const { rows } = await testDb.base.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'org.consent_records'::regclass`,
      );
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const col = await testDb.base.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='org' AND table_name='consent_records' AND column_name='org_id' AND is_nullable='NO'`);
      expect(col.rows).toHaveLength(1);
    });

    it('app_rw 只有 SELECT 與 INSERT', async () => {
      const { rows } = await testDb.base.query<{ p: string; ok: boolean }>(
        `SELECT p, has_table_privilege('app_rw', 'org.consent_records', p) AS ok
           FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p`,
      );
      expect(Object.fromEntries(rows.map((r) => [r.p, r.ok]))).toEqual({
        SELECT: true, INSERT: true, UPDATE: false, DELETE: false, TRUNCATE: false, REFERENCES: false, TRIGGER: false,
      });
    });

    it('app_rw 的 UPDATE、DELETE、TRUNCATE 被權限擋下', async () => {
      for (const sql of ['UPDATE org.consent_records SET decision = \'agree\'', 'DELETE FROM org.consent_records', 'TRUNCATE org.consent_records']) {
        await expect(f.withTx(orgCtx(ORG_A), (tx) => tx.query(sql)), sql).rejects.toThrow(/permission denied/);
      }
      expect(await rowsOf(orgCtx(ORG_A))).toHaveLength(1);
    });

    it('觸發器擋下有權限的身分：superuser 的 UPDATE、DELETE、TRUNCATE', async () => {
      for (const sql of ['UPDATE org.consent_records SET decision = \'agree\'', 'DELETE FROM org.consent_records', 'TRUNCATE org.consent_records']) {
        await asSuperuser(f.db, async () => {
          await expect(f.db.query(sql), sql).rejects.toThrow(/同意紀錄只增不改/);
        });
      }
    });

    it('觸發器擋下表的擁有者 app_owner 的 TRUNCATE，UPDATE 與 DELETE 在 FORCE RLS 下看不到列', async () => {
      await f.db.exec('RESET ROLE');
      try {
        await f.db.exec('SET ROLE app_owner');
        await expect(f.db.query('TRUNCATE org.consent_records')).rejects.toThrow(/同意紀錄只增不改/);
        const res = await f.db.query('DELETE FROM org.consent_records');
        expect(res.affectedRows ?? 0).toBe(0);
      } finally {
        await f.db.exec('RESET ROLE');
        await f.db.exec('SET ROLE app_rw');
      }
      expect(await rowsOf(orgCtx(ORG_A))).toHaveLength(1);
    });

    it('滲透：A 讀不到 B 的列，無脈絡與 party、control 脈絡讀到 0 筆', async () => {
      const count = (ctx: Parameters<typeof f.withTx>[0]) =>
        f.withTx(ctx, async (tx) => Number((await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM org.consent_records')).rows[0].n));
      expect(await count(orgCtx(ORG_A))).toBe(1);
      expect(await count(orgCtx(ORG_B))).toBe(1);
      expect(await count({ kind: 'control' })).toBe(0);
      expect(await count({ kind: 'party', partyId: PARTY_P })).toBe(0);
      const other = await f.withTx(orgCtx(ORG_A), async (tx) => (await tx.query('SELECT * FROM org.consent_records WHERE org_id = $1', [ORG_B])).rows);
      expect(other).toEqual([]);
    });

    it('滲透：A 脈絡不能寫入 B 的 org_id，也不能在沒有脈絡時寫入', async () => {
      const insertFor = (orgId: string) => (tx: { query: (s: string, p?: unknown[]) => Promise<unknown> }) =>
        tx.query(
          `INSERT INTO org.consent_records (id, org_id, notice_type, notice_version, text_sha256, subject_email, decision, source, audit_chain_id, audit_seq)
           VALUES ('01JBKQ00000000000000000Z09', $1, 'esign', 1, repeat('a', 64), 'x@example.com', 'agree', 'in_app', $1, 1)`,
          [orgId],
        );
      await expect(f.withTx(orgCtx(ORG_A), insertFor(ORG_B))).rejects.toThrow(/row-level security/);
      await expect(f.withTx({ kind: 'control' }, insertFor(ORG_A))).rejects.toThrow(/row-level security/);
      await expect(f.withTx({ kind: 'party', partyId: PARTY_P }, insertFor(ORG_A))).rejects.toThrow(/row-level security/);
    });

    it('滲透：用 recordConsent 在 A 脈絡寫入，org_id 一定是 A，沒有參數可以指定別的組織', async () => {
      const rec = await f.withTx(orgCtx(ORG_A), (tx) => recordConsent(tx, { ...base, subject: { email: 'z@example.com' }, ...({ orgId: ORG_B } as object) }));
      expect(rec.orgId).toBe(ORG_A);
      expect(await rowsOf(orgCtx(ORG_B))).toHaveLength(1); // B 仍只有自己原本那筆
    });

    it('稽核事件位置的 chain 必須等於 org_id（資料庫 CHECK）', async () => {
      await expect(
        f.withTx(orgCtx(ORG_A), (tx) =>
          tx.query(
            `INSERT INTO org.consent_records (id, org_id, notice_type, notice_version, text_sha256, subject_email, decision, source, audit_chain_id, audit_seq)
             VALUES ('01JBKQ00000000000000000Z08', $1, 'esign', 1, repeat('a', 64), 'x@example.com', 'agree', 'in_app', $2, 1)`,
            [ORG_A, ORG_B],
          ),
        ),
      ).rejects.toThrow(/consent_audit_chain_is_org/);
    });
  });
});
