import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLATFORM_ORG_ID } from '../auth/config';
import { completeLogin, loadLiveSession, requestLoginCode, resolveRequestContext, type LoginDeps } from '../auth/login-flow';
import { createLocalFileStore } from '../file-store/local-file-store';
import type { FileStore } from '../file-store';
import { createMockMailer, type MockMailer } from '../mailer/mock-mailer';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import type { OrgTx } from '../pg/with-tx';
import { createPracticeOrg } from '../orgs/onboarding';
import type { OperatorRun, FlowDeps, SubmitActor } from './flows';
import type { EvidenceUpload } from './rules';

// MIL-109 整合測試的共用工具：真的 migration、app_rw 連線、本機 FileStore、mock 寄信。

export const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n證書影本');
export const pdf = (name = '許可函.pdf'): EvidenceUpload => ({ fileName: name, contentType: 'application/pdf', bytes: PDF_BYTES });

export interface PracticeKit {
  kit: RouteDb;
  mailer: MockMailer;
  store: FileStore;
  storeRoot: string;
  deps: FlowDeps;
  operatorRun: OperatorRun;
  login(email: string): Promise<{ token: string }>;
  practiceAccount(email: string, form?: Record<string, unknown>): Promise<Account>;
  operatorAccount(email?: string): Promise<{ token: string; userId: string; run: OperatorRun }>;
  /** 營運者查 registry。asOwner 的簡寫。 */
  registry<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** FileStore 根目錄下所有檔案的相對路徑。 */
  storeFiles(): string[];
  close(): Promise<void>;
  reset(): Promise<void>;
}

export interface Account extends SubmitActor {
  token: string;
}

const T0 = new Date('2026-11-09T10:00:00Z');

export async function setupPracticeKit(): Promise<PracticeKit> {
  const kit = await setupRouteDb();
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-entities-'));
  const store = createLocalFileStore(storeRoot);
  let mailer = createMockMailer();
  let clock = 0;
  const env = { PLATFORM_OPERATOR_EMAILS: 'ops@example.com' };
  const now = () => new Date(T0.getTime() + clock);
  const deps = (): LoginDeps => {
    clock += 120_000;
    return { now: new Date(T0.getTime() + clock), secret: 'test-secret', mailer, env };
  };

  async function login(email: string) {
    const d = deps();
    const sent = await requestLoginCode(email, d);
    if (sent.status !== 'sent') throw new Error(`寄驗證碼失敗：${sent.status}`);
    const code = mailer.sent.at(-1)!.text.match(/\d{6}/)![0];
    const result = await completeLogin(email, code, d);
    if (result.status !== 'ok') throw new Error('登入失敗');
    return result;
  }

  const operatorRunFor = (operatorId: string): OperatorRun => (ticketId, fn) =>
    withTx({ kind: 'operator', operatorId, orgId: PLATFORM_ORG_ID, ticketId }, (tx) => fn(tx as OrgTx));

  const self: PracticeKit = {
    kit,
    get mailer() {
      return mailer;
    },
    store,
    storeRoot,
    get deps() {
      return { store, mailer, now };
    },
    operatorRun: operatorRunFor('00000000000000000000000003'),
    login,
    async practiceAccount(email, form = {}) {
      const { token } = await login(email);
      const result = await createPracticeOrg(
        token,
        { name: '安心代管有限公司', taxId: '12345678', entityType: 'company', kinds: ['management'], ...form },
        { now: now() },
      );
      if (result.status !== 'ok') throw new Error(`建執業主體組織失敗：${JSON.stringify(result)}`);
      const rc = await resolveRequestContext(token, now(), 'test');
      if (rc.kind !== 'org') throw new Error('建完組織後應該是組織身分');
      return { token, orgId: rc.orgId, orgKind: rc.orgKind, role: rc.role, userId: rc.userId, partyId: rc.partyId };
    },
    async operatorAccount(email = 'ops@example.com') {
      const { token } = await login(email);
      const session = await loadLiveSession(token, now());
      if (!session) throw new Error('沒有 session');
      return { token, userId: session.userId, run: operatorRunFor(session.userId) };
    },
    storeFiles() {
      const out: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out.push(path.relative(storeRoot, full));
        }
      };
      walk(storeRoot);
      return out.sort();
    },
    // vault 的表歸 vault_owner，app_owner 沒有 vault 的 USAGE，所以查 vault 時換成 vault_owner
    registry: (sql, params) =>
      kit.asOwner(async (db) => {
        if (/\bvault\./.test(sql)) await db.exec('SET ROLE vault_owner');
        return (await db.query(sql, params)).rows as never;
      }),
    async reset() {
      await kit.reset();
      mailer = createMockMailer();
      clock = 0;
      fs.rmSync(storeRoot, { recursive: true, force: true });
      fs.mkdirSync(storeRoot, { recursive: true });
    },
    async close() {
      await kit.close();
      fs.rmSync(storeRoot, { recursive: true, force: true });
    },
  };
  return self;
}
