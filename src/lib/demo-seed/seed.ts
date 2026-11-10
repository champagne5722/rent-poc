import { listIdentityOptions, provisionAccount, type Account } from '../auth/account-service';
import { PLATFORM_OPERATOR_EMAILS_ENV, PLATFORM_ORG_ID } from '../auth/config';
import { normalizeEmail } from '../auth/email';
import { logout } from '../auth/login-flow';
import { openSession } from '../auth/session-service';
import { getFileStore, type FileStore } from '../file-store';
import { createOwnerOrg, createPracticeOrg } from '../orgs/onboarding';
import { decideOwnershipFlow, type OperatorRuns } from '../ownership/desk';
import { submitTranscriptFlow } from '../ownership/flows';
import { getOwnershipGate, recordTranscriptConsent } from '../ownership/repository';
import { withTx } from '../pg/database';
import type { OrgTx } from '../pg/with-tx';
import { listQueue } from '../practice-entities/desk';
import { deskTicket } from '../practice-entities/ticket';
import { parsePropertyCreateInput, registerProperty } from '../properties';

// 示範資料的種子（MIL-91，ADR-0012 決議 9、11）。
// 全部走既有的帳號、組織與物件函式，所以 RLS 與稽核都生效，沒有直接寫表。
// 示範物件也走正式的核對流程（MIL-205）：同意個資告知、送出謄本、平台營運者判定通過。
// 物件通過核對後才能建立案件，示範屋主才能直接示範建約。
// 能重複執行：帳號、組織、物件各自先檢查再建，第二次執行不新增任何資料。
// 連線身分是 DATABASE_URL 指定的 app_rw。只有示範用的假值，沒有真實個資。

export const DEMO_SEED_ROLES = ['owner', 'manager', 'masterLessor', 'tenant', 'operator'] as const;
export type DemoSeedRole = (typeof DEMO_SEED_ROLES)[number];

/** 環境變數名稱。與正式環境的 SEED_OWNER_EMAIL（預設組織的 admin）無關，刻意用不同的名稱。 */
export const DEMO_SEED_EMAIL_ENV: Record<DemoSeedRole, string> = {
  owner: 'DEMO_SEED_OWNER_EMAIL',
  manager: 'DEMO_SEED_MANAGER_EMAIL',
  masterLessor: 'DEMO_SEED_MASTER_LESSOR_EMAIL',
  tenant: 'DEMO_SEED_TENANT_EMAIL',
  operator: 'DEMO_SEED_OPERATOR_EMAIL',
};

/** 沒設環境變數時的預設值。example.com 是保留網域，收不到信，登入驗證碼看 /demo/otp。 */
export const DEMO_SEED_DEFAULT_EMAIL: Record<DemoSeedRole, string> = {
  owner: 'demo-owner@example.com',
  manager: 'demo-manager@example.com',
  masterLessor: 'demo-master-lessor@example.com',
  tenant: 'demo-tenant@example.com',
  operator: 'demo-operator@example.com',
};

/**
 * 示範業者的統一編號。商工登記的統編有檢查碼，這兩個值的檢查碼不成立，所以不會與任何真實公司相同。
 * 平台只檢查 8 碼數字（ADR-0017 決議 2）。
 */
export const DEMO_MANAGER_TAX_ID = '00000001';
export const DEMO_MASTER_LESSOR_TAX_ID = '00000002';

export const DEMO_ORG_NAME = {
  owner: '示範屋主',
  manager: '示範代管股份有限公司',
  masterLessor: '示範包租股份有限公司',
} as const;

/** 示範物件。地址與建號都是示範值，名稱帶「示範」兩字讓人一眼看出。 */
export const DEMO_PROPERTY = {
  name: '示範物件：大安區 3 樓',
  address: '臺北市大安區示範路 1 號 3 樓',
  anchor: { key: { city: 'A', town: '02', section: '0021', buildingNo: '99999', subNo: '' } },
  default_rent: 20000,
  size: 20,
  note: '示範資料，不是真實物件。',
  equipment: [],
};

/** 示範謄本的內容與表單。檔案內容是明顯的示範文字，不是真實謄本。 */
export const DEMO_TRANSCRIPT = {
  fileName: '示範謄本.pdf',
  bytes: new TextEncoder().encode('%PDF-1.7\n示範資料，不是真實謄本。'),
  form: { claimedOwner: '示範屋主', acquiredAt: '2026-11-01' },
  /** 營運者判定的遮罩名義人與理由，也是示範值。 */
  holderMasked: '示範○主',
  reason: '示範資料，種子判定通過',
} as const;

/** 輸出與步驟名稱用的中文名。用 GLOSSARY.md 的詞。 */
export const DEMO_SEED_ROLE_LABEL: Record<DemoSeedRole, string> = {
  owner: '屋主',
  manager: '代管業者',
  masterLessor: '包租業者',
  tenant: '承租人',
  operator: '平台營運者',
};

export type DemoSeedEmails = Record<DemoSeedRole, string>;

/** 讀環境變數。值不合格時丟錯，不靜默改用預設值，避免寄到想不到的地址。 */
export function readDemoSeedEmails(env: Readonly<Record<string, string | undefined>>): DemoSeedEmails {
  const emails = {} as DemoSeedEmails;
  for (const role of DEMO_SEED_ROLES) {
    const name = DEMO_SEED_EMAIL_ENV[role];
    const raw = env[name]?.trim();
    const email = normalizeEmail(raw ? raw : DEMO_SEED_DEFAULT_EMAIL[role]);
    if (!email) throw new Error(`${name} 不是合格的 email：${raw}`);
    emails[role] = email;
  }
  if (new Set(Object.values(emails)).size !== DEMO_SEED_ROLES.length) {
    throw new Error('五個種子帳號的 email 必須各不相同');
  }
  return emails;
}

export interface DemoSeedStep {
  step: string;
  /** created：這次建立。exists：已存在，沒有改動。 */
  result: 'created' | 'exists';
}

interface Context {
  now: Date;
  /** 帳號第一次建立時，provisionAccount 依這份環境補成員資格。 */
  env: Readonly<Record<string, string | undefined>>;
}

export interface DemoSeedDeps {
  now: Date;
  /** 示範謄本存放的 FileStore。預設是正式設定的 general 用途 FileStore。 */
  store?: FileStore;
  /** 讀 PLATFORM_OPERATOR_EMAILS。平台營運者的成員資格由帳號第一次建立時的環境變數決定。 */
  env?: Readonly<Record<string, string | undefined>>;
}

function ensureAccount(email: string, ctx: Context): Promise<Account> {
  return withTx({ kind: 'control' }, (tx) => provisionAccount(tx, { email, now: ctx.now, env: ctx.env }));
}

function identityOptions(account: Account) {
  return withTx({ kind: 'control' }, (tx) => listIdentityOptions(tx, account));
}

async function partyExists(email: string): Promise<boolean> {
  return withTx({ kind: 'control' }, async (tx) => (await tx.query('SELECT 1 FROM control.parties WHERE email = $1', [email])).rows.length > 0);
}

/** 為還沒有任何身分的帳號開 session、建組織、登出。session 不留在資料庫。 */
async function createOrgFor(account: Account, now: Date, create: (token: string) => Promise<{ status: string }>): Promise<void> {
  const { token } = await withTx({ kind: 'control' }, (tx) =>
    openSession(tx, { userId: account.userId, partyId: account.partyId, identity: null, now }),
  );
  try {
    const result = await create(token);
    if (result.status !== 'ok') throw new Error(`建組織失敗：${JSON.stringify(result)}`);
  } finally {
    await logout(token);
  }
}

type OrgRole = 'owner' | 'manager' | 'masterLessor';

function createOrgByRole(role: OrgRole, token: string, now: Date) {
  switch (role) {
    case 'owner':
      return createOwnerOrg(token, { name: DEMO_ORG_NAME.owner }, { now });
    case 'manager':
      return createPracticeOrg(
        token,
        { name: DEMO_ORG_NAME.manager, taxId: DEMO_MANAGER_TAX_ID, entityType: 'company', kinds: ['management'] },
        { now },
      );
    case 'masterLessor':
      return createPracticeOrg(
        token,
        { name: DEMO_ORG_NAME.masterLessor, taxId: DEMO_MASTER_LESSOR_TAX_ID, entityType: 'company', kinds: ['master_lease'] },
        { now },
      );
  }
}

async function ensureOrgAccount(role: OrgRole, email: string, ctx: Context, steps: DemoSeedStep[]): Promise<{ account: Account; orgId: string }> {
  const account = await ensureAccount(email, ctx);
  let options = await identityOptions(account);
  if (options.length === 0) {
    await createOrgFor(account, ctx.now, (token) => createOrgByRole(role, token, ctx.now));
    options = await identityOptions(account);
    steps.push({ step: `${DEMO_SEED_ROLE_LABEL[role]}的組織`, result: 'created' });
  } else {
    steps.push({ step: `${DEMO_SEED_ROLE_LABEL[role]}的組織`, result: 'exists' });
  }
  const org = options.find((o) => o.identity.kind === 'org');
  if (!org || org.identity.kind !== 'org') throw new Error(`${role} 帳號沒有組織身分：${email}`);
  return { account, orgId: org.identity.orgId };
}

async function ensureProperty(account: Account, orgId: string, steps: DemoSeedStep[]): Promise<void> {
  const parsed = parsePropertyCreateInput(DEMO_PROPERTY);
  if (!parsed.ok) throw new Error(`示範物件的內容不合格：${parsed.error}`);
  const created = await withTx({ kind: 'org', orgId, partyId: account.partyId }, async (tx) => {
    const { rows } = await tx.query('SELECT 1 FROM org.properties WHERE name = $1', [DEMO_PROPERTY.name]);
    if (rows.length > 0) return false;
    await registerProperty(tx, parsed.value);
    return true;
  });
  steps.push({ step: '屋主的示範物件', result: created ? 'created' : 'exists' });
}

/** 營運者身分的兩種交易，與 route 用的相同（ownership/operator.ts），只是這裡沒有請求脈絡。 */
function operatorRunsOf(operatorUserId: string): OperatorRuns {
  return {
    platform: (ticketId, fn) => withTx({ kind: 'operator', operatorId: operatorUserId, orgId: PLATFORM_ORG_ID, ticketId }, (tx) => fn(tx as OrgTx)),
    inOrg: (orgId, ticketId, fn) => withTx({ kind: 'operator', operatorId: operatorUserId, orgId, ticketId }, (tx) => fn(tx as OrgTx)),
  };
}

/**
 * 讓示範物件通過文件核對。已核對就不動。做法與正式流程相同：
 * 屋主同意個資告知、送出謄本（沒有節點或驗證失敗時）、營運者在審核台判定通過。
 * 重跑時：已核對回 exists。停在待驗證（上次中斷）時只補判定。
 */
async function ensureOwnershipVerified(
  owner: { account: Account; orgId: string },
  operatorUserId: string,
  deps: DemoSeedDeps,
  steps: DemoSeedStep[],
): Promise<void> {
  const ctx = { kind: 'org', orgId: owner.orgId, partyId: owner.account.partyId } as const;
  const lookup = () =>
    withTx(ctx, async (tx) => {
      const { rows } = await tx.query<{ id: string; rental_unit_id: string }>('SELECT id, rental_unit_id FROM org.properties WHERE name = $1', [DEMO_PROPERTY.name]);
      if (!rows[0]) throw new Error('找不到示範物件');
      return { propertyId: rows[0].id, gate: await getOwnershipGate(tx, rows[0].rental_unit_id) };
    });

  const { propertyId, gate: initialGate } = await lookup();
  let gate = initialGate;
  if (gate.nodeStatus === 'verified') {
    steps.push({ step: '示範物件通過文件核對', result: 'exists' });
    return;
  }
  if (gate.nodeStatus !== 'pending_verification') {
    await withTx(ctx, (tx) => recordTranscriptConsent(tx, propertyId, owner.account.partyId, 'agree'));
    const submitted = await submitTranscriptFlow(
      { orgId: owner.orgId, partyId: owner.account.partyId },
      propertyId,
      { ...DEMO_TRANSCRIPT.form },
      { fileName: DEMO_TRANSCRIPT.fileName, contentType: 'application/pdf', bytes: DEMO_TRANSCRIPT.bytes },
      { store: deps.store ?? getFileStore('general'), now: () => deps.now },
    );
    if (submitted.status !== 'submitted') throw new Error(`示範謄本送出失敗：${submitted.status}`);
    gate = (await lookup()).gate;
  }

  const runs = operatorRunsOf(operatorUserId);
  const items = await runs.platform(deskTicket('queue'), (tx) => listQueue(tx, 'open', deps.now));
  const item = items.find((i) => i.type === 'leasing_authority' && i.subjectId === gate.node?.id);
  if (!item) throw new Error('找不到示範物件待核對的審核項目');
  const decided = await decideOwnershipFlow(runs, item.id, {
    keyMatch: true,
    holderMatch: true,
    holderMasked: DEMO_TRANSCRIPT.holderMasked,
    reason: DEMO_TRANSCRIPT.reason,
  });
  if (decided.status !== 'recorded' || decided.outcome !== 'verified') throw new Error(`示範物件核對失敗：${decided.status}`);
  steps.push({ step: '示範物件通過文件核對', result: 'created' });
}

/**
 * 建立五個示範帳號與最少的資料：屋主組織加一個物件、代管業者與包租業者各一個組織、
 * 承租人與平台營運者的帳號。承租人身分要等有案件才出現，所以只建帳號。
 * 最後讓示範物件通過文件核對，屋主才能直接建立案件。
 */
export async function runDemoSeed(emails: DemoSeedEmails, deps: DemoSeedDeps): Promise<DemoSeedStep[]> {
  // 只有平台營運者的帳號帶營運者名單，其他帳號不得因為環境變數取得平台營運者資格
  const operatorList = [deps.env?.[PLATFORM_OPERATOR_EMAILS_ENV], emails.operator].filter(Boolean).join(',');
  const operatorCtx: Context = { now: deps.now, env: { [PLATFORM_OPERATOR_EMAILS_ENV]: operatorList } };
  const plainCtx: Context = { now: deps.now, env: {} };
  const steps: DemoSeedStep[] = [];

  const owner = await ensureOrgAccount('owner', emails.owner, plainCtx, steps);
  await ensureProperty(owner.account, owner.orgId, steps);
  await ensureOrgAccount('manager', emails.manager, plainCtx, steps);
  await ensureOrgAccount('masterLessor', emails.masterLessor, plainCtx, steps);

  const tenantExisted = await partyExists(emails.tenant);
  await ensureAccount(emails.tenant, plainCtx);
  steps.push({ step: '承租人的帳號', result: tenantExisted ? 'exists' : 'created' });

  const operatorExisted = await partyExists(emails.operator);
  const operator = await ensureAccount(emails.operator, operatorCtx);
  steps.push({ step: '平台營運者的帳號', result: operatorExisted ? 'exists' : 'created' });

  // 營運者帳號建好後，示範物件才能走完核對流程
  await ensureOwnershipVerified(owner, operator.userId, deps, steps);
  return steps;
}
