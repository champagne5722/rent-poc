import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listIdentityOptions } from '../auth/account-service';
import { createLocalFileStore } from '../file-store/local-file-store';
import { getOwnershipGate } from '../ownership/repository';
import { withTx } from '../pg/database';
import { setupRouteDb, TEST_PARTY_ID, type RouteDb } from '../pg/route-test-kit';
import {
  DEMO_MANAGER_TAX_ID,
  DEMO_ORG_NAME,
  DEMO_SEED_DEFAULT_EMAIL,
  DEMO_SEED_EMAIL_ENV,
  DEMO_SEED_ROLES,
  readDemoSeedEmails,
  runDemoSeed,
} from './seed';

// 示範資料種子（MIL-91）：連跑兩次，第二次不新增任何資料。資料庫是 PGlite（app_rw，RLS 生效）。

const NOW = new Date('2026-11-10T10:00:00Z');
const COUNTED_TABLES = [
  'control.parties',
  'control.users',
  'control.orgs',
  'control.org_memberships',
  'control.sessions',
  'audit.events',
];

let kit: RouteDb;
let storeRoot: string;
let store: ReturnType<typeof createLocalFileStore>;
beforeAll(async () => {
  kit = await setupRouteDb();
  await kit.reset();
  storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-seed-'));
  store = createLocalFileStore(storeRoot);
});
afterAll(async () => {
  await kit.close();
  fs.rmSync(storeRoot, { recursive: true, force: true });
});

async function counts(): Promise<Record<string, number>> {
  return kit.asOwner(async (db) => {
    const out: Record<string, number> = {};
    for (const table of COUNTED_TABLES) {
      // 稽核表歸 audit_owner，app_owner 沒有讀取權限
      await db.exec(table.startsWith('audit.') ? 'SET ROLE audit_owner' : 'SET ROLE app_owner');
      const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      out[table] = rows[0].n;
    }
    return out;
  }).then(async (out) => {
    const org = await withTx({ kind: 'control' }, (tx) =>
      tx.query<{ id: string }>('SELECT id FROM control.orgs WHERE name = $1', [DEMO_ORG_NAME.owner]),
    );
    // 物件、所有權節點、謄本送件與通知都掛 RLS，要用屋主組織的脈絡才讀得到
    for (const table of ['org.properties', 'org.ownership_nodes', 'org.ownership_submissions', 'org.notifications']) {
      out[table] =
        org.rows.length === 0
          ? 0
          : await withTx({ kind: 'org', orgId: org.rows[0].id, partyId: TEST_PARTY_ID }, async (tx) =>
              (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
            );
    }
    return out;
  });
}

describe('readDemoSeedEmails', () => {
  it('沒設環境變數時用 example.com 的預設值', () => {
    const emails = readDemoSeedEmails({});
    for (const role of DEMO_SEED_ROLES) {
      expect(emails[role]).toBe(DEMO_SEED_DEFAULT_EMAIL[role]);
      expect(emails[role].endsWith('@example.com')).toBe(true);
    }
  });

  it('環境變數的值轉成小寫並去空白', () => {
    expect(readDemoSeedEmails({ [DEMO_SEED_EMAIL_ENV.owner]: '  Owner@Example.org ' }).owner).toBe('owner@example.org');
  });

  it('值不合格或重複時丟錯', () => {
    expect(() => readDemoSeedEmails({ [DEMO_SEED_EMAIL_ENV.owner]: 'not-an-email' })).toThrow(DEMO_SEED_EMAIL_ENV.owner);
    expect(() =>
      readDemoSeedEmails({ [DEMO_SEED_EMAIL_ENV.owner]: 'same@example.org', [DEMO_SEED_EMAIL_ENV.tenant]: 'same@example.org' }),
    ).toThrow('各不相同');
  });
});

describe('runDemoSeed', () => {
  it('第一次建立全部資料，第二次執行不新增任何資料', async () => {
    const emails = readDemoSeedEmails({});
    const first = await runDemoSeed(emails, { now: NOW, store });
    expect(first.every((s) => s.result === 'created')).toBe(true);
    const afterFirst = await counts();

    const second = await runDemoSeed(emails, { now: new Date(NOW.getTime() + 60_000), store });
    expect(second.every((s) => s.result === 'exists')).toBe(true);
    expect(await counts()).toEqual(afterFirst);
  });

  it('建出五個帳號，各自有對應的身分', async () => {
    const emails = readDemoSeedEmails({});
    const kindsOf = async (email: string) =>
      withTx({ kind: 'control' }, async (tx) => {
        const { rows } = await tx.query<{ user_id: string; party_id: string }>(
          'SELECT u.id AS user_id, p.id AS party_id FROM control.parties p JOIN control.users u ON u.party_id = p.id WHERE p.email = $1',
          [email],
        );
        expect(rows).toHaveLength(1);
        const options = await listIdentityOptions(tx, { userId: rows[0].user_id, partyId: rows[0].party_id });
        return options.map((o) => o.kind);
      });

    expect(await kindsOf(emails.owner)).toEqual(['owner']);
    expect(await kindsOf(emails.manager)).toEqual(['practice']);
    expect(await kindsOf(emails.masterLessor)).toEqual(['practice']);
    // 承租人身分要有案件才成立
    expect(await kindsOf(emails.tenant)).toEqual([]);
    expect(await kindsOf(emails.operator)).toEqual(['operator']);
  });

  it('只有營運者帳號有平台組織的成員資格', async () => {
    const { rows } = await withTx({ kind: 'control' }, (tx) =>
      tx.query<{ email: string }>(
        `SELECT p.email FROM control.org_memberships m
           JOIN control.orgs o ON o.id = m.org_id AND o.kind = 'platform'
           JOIN control.users u ON u.id = m.user_id
           JOIN control.parties p ON p.id = u.party_id`,
      ),
    );
    expect(rows.map((r) => r.email)).toEqual([DEMO_SEED_DEFAULT_EMAIL.operator]);
  });

  it('示範物件走正式流程通過核對：一個已驗證的節點、一份送件、一則通知，重跑不增加', async () => {
    const state = await counts();
    expect(state['org.ownership_nodes']).toBe(1);
    expect(state['org.ownership_submissions']).toBe(1);
    expect(state['org.notifications']).toBe(1);
    const org = await withTx({ kind: 'control' }, (tx) => tx.query<{ id: string }>('SELECT id FROM control.orgs WHERE name = $1', [DEMO_ORG_NAME.owner]));
    const gate = await withTx({ kind: 'org', orgId: org.rows[0].id, partyId: TEST_PARTY_ID }, async (tx) => {
      const { rows } = await tx.query<{ rental_unit_id: string }>('SELECT rental_unit_id FROM org.properties');
      return getOwnershipGate(tx, rows[0].rental_unit_id);
    });
    expect(gate.nodeStatus).toBe('verified');
  });

  it('屋主組織有一個示範物件，不留 session，示範業者的統編不是真實統編', async () => {
    const state = await counts();
    expect(state['org.properties']).toBe(1);
    expect(state['control.sessions']).toBe(0);
    // 台灣統編的檢查碼：各位數乘 1,2,1,2,1,2,4,1，十位數相加後必須被 10 整除（第 7 位是 7 時另有規則）
    const valid = (id: string) => {
      const weights = [1, 2, 1, 2, 1, 2, 4, 1];
      const sum = [...id].reduce((acc, ch, i) => {
        const p = Number(ch) * weights[i];
        return acc + Math.floor(p / 10) + (p % 10);
      }, 0);
      return sum % 10 === 0 || (id[6] === '7' && (sum + 1) % 10 === 0);
    };
    expect(valid(DEMO_MANAGER_TAX_ID)).toBe(false);
  });
});

describe('已跑過舊版種子的資料庫', () => {
  it('物件已存在但沒有核對時，重跑新版種子後示範物件變成已核對，不重複建立物件', async () => {
    await kit.reset();
    const emails = readDemoSeedEmails({});
    // 謄本寫檔失敗：種子建完帳號、組織與物件後在核對這一步中斷，資料庫停在舊版種子的狀態
    const brokenStore = { ...store, write: async () => { throw new Error('寫檔失敗'); } } as typeof store;
    await expect(runDemoSeed(emails, { now: NOW, store: brokenStore })).rejects.toThrow('寫檔失敗');
    const before = await counts();
    expect(before['org.properties']).toBe(1);
    expect(before['org.ownership_nodes']).toBe(0);

    const steps = await runDemoSeed(emails, { now: new Date(NOW.getTime() + 60_000), store });
    expect(steps.find((s) => s.step === '屋主的示範物件')?.result).toBe('exists');
    expect(steps.find((s) => s.step === '示範物件通過文件核對')?.result).toBe('created');
    const after = await counts();
    expect(after['org.properties']).toBe(1);
    expect(after['org.ownership_nodes']).toBe(1);
  });
});
