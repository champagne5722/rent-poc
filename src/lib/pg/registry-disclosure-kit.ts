import { PLATFORM_ORG_ID } from '../auth/config';
import { createContract } from '../contracts/repository';
import { replaceAssignments } from '../practitioner-assignment/repository';
import { setupLiveKit, type LiveKit, type LiveWorld } from '../practice-registry/live-test-kit';
import { withTx } from './database';
import type { DisclosureFixture, DisclosureSubject, PiiField } from './rls-cases/types';
import { newUlid } from './ulid';
import type { DbContext, OrgTx } from './with-tx';

// 個資揭露矩陣的測試資料與呼叫者關係（MIL-165）。測試在 registry-disclosure.test.ts，
// 規則全文在 src/lib/practice-registry/README.md 的「個資揭露矩陣」。
//
// 世界沿用 practiceRegistry 真實 adapter 的測試資料（live-test-kit）：北辰有專任管理人員（陳怡君）、
// 待驗證任職（吳家豪）、證書失效（周大衛）、任職已結束（許文傑）。這裡再加營運者、審核台項目與各關係的呼叫者。

// ---------------------------------------------------------------------------
// 呼叫者關係

export interface CallerRelationRow {
  /** 期望值表（ExposureTable.by）用這個名字當 key。 */
  name: string;
  label: string;
  /**
   * 這種關係是呼叫者自己能建立的：建草稿合約、存一筆指派、替案件加成員、開一個執業主體組織，都不需要任何人同意。
   * 能自己建立的關係，不得解鎖證號原文（README 的規則）。
   */
  creatable: boolean;
  context(world: DisclosureWorld): DbContext;
}

/**
 * 每種關係一列。MIL-200 拿掉 `selecting`（選人階段）與「合約指派造出 bound」。
 * `draftAssigned` 留著當對照：草稿合約的指派指向北辰，現在與無關的組織相同，什麼都讀不到。
 */
export const CALLER_RELATIONS: readonly CallerRelationRow[] = [
  {
    name: 'own',
    label: '自己的組織（北辰的成員）',
    creatable: false,
    context: (w) => ({ kind: 'org', orgId: w.live.world.beichen.orgId, partyId: w.live.world.beichen.people.chen.partyId }),
  },
  {
    name: 'operator',
    label: '平台營運者',
    creatable: false,
    context: (w) => ({ kind: 'operator', operatorId: w.operatorUserId, orgId: PLATFORM_ORG_ID, ticketId: 'MIL-165' }),
  },
  {
    name: 'draftAssigned',
    label: '草稿合約的指派指向北辰（MIL-200 起不再綁定）',
    creatable: true,
    context: (w) => ({ kind: 'org', orgId: w.live.world.boundOrgId, partyId: w.members.draftAssigned }),
  },
  {
    name: 'bound',
    label: '已綁定（案件成員屬於北辰）',
    creatable: true,
    context: (w) => ({ kind: 'org', orgId: w.live.world.caseBoundOrgId, partyId: w.members.bound }),
  },
  {
    name: 'unrelated',
    label: '無關的組織（另一個執業主體組織的成員）',
    creatable: true,
    context: (w) => ({ kind: 'org', orgId: w.unrelatedPracticeOrgId, partyId: w.members.unrelated }),
  },
  {
    name: 'unrelatedOwner',
    label: '無關的組織（沒有合約的屋主組織）',
    creatable: true,
    context: (w) => ({ kind: 'org', orgId: w.live.world.unrelatedOrgId, partyId: w.members.unrelatedOwner }),
  },
  {
    name: 'noContext',
    label: '沒有組織脈絡',
    creatable: true,
    context: () => ({ kind: 'control' }),
  },
];

// ---------------------------------------------------------------------------
// 世界

export interface DisclosureWorld {
  live: LiveKit;
  fixture: DisclosureFixture;
  operatorUserId: string;
  unrelatedPracticeOrgId: string;
  /** 各關係的呼叫者 party：該組織的一般成員，不是北辰的人。 */
  members: Record<'draftAssigned' | 'bound' | 'unrelated' | 'unrelatedOwner', string>;
  /** 偵測個資用的特徵值。 */
  sentinels: Record<PiiField, readonly string[]>;
  close(): Promise<void>;
}

async function addMember(live: LiveKit, orgId: string, label: string): Promise<string> {
  const partyId = newUlid();
  const userId = newUlid();
  await live.owner('INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)', [partyId, `${label}.${partyId.toLowerCase()}@members.test`, label]);
  await live.owner('INSERT INTO control.users (id, party_id) VALUES ($1, $2)', [userId, partyId]);
  await live.owner('INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)', [newUlid(), orgId, userId, 'staff']);
  return partyId;
}

export async function setupDisclosureWorld(): Promise<DisclosureWorld> {
  const live = await setupLiveKit();
  const w: LiveWorld = live.world;

  // 營運者：平台組織的成員
  await live.owner(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '平台', 'platform') ON CONFLICT (id) DO NOTHING`, [PLATFORM_ORG_ID]);
  const operatorParty = newUlid();
  const operatorUserId = newUlid();
  await live.owner('INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)', [operatorParty, 'ops@platform.test', '營運者']);
  await live.owner('INSERT INTO control.users (id, party_id) VALUES ($1, $2)', [operatorUserId, operatorParty]);
  await live.owner('INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)', [newUlid(), PLATFORM_ORG_ID, operatorUserId, 'admin']);

  // 無關的執業主體組織：有成員，沒有執業主體登錄、合約與綁定
  const unrelatedPracticeOrgId = newUlid();
  await live.owner(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '無關的執業主體組織', 'practice')`, [unrelatedPracticeOrgId]);

  const members = {
    draftAssigned: await addMember(live, w.boundOrgId, '指派的屋主成員'),
    bound: await addMember(live, w.caseBoundOrgId, '案件綁定的屋主成員'),
    unrelated: await addMember(live, unrelatedPracticeOrgId, '無關的執業人員'),
    unrelatedOwner: await addMember(live, w.unrelatedOrgId, '無關的屋主成員'),
  };

  // 審核台項目：業別（要有許可字號才會列出）、專任管理人員的證書、已結束的任職
  const chenPractitioner = (await live.owner<{ id: string }>('SELECT id FROM registry.practitioners WHERE party_id = $1', [w.beichen.people.chen.partyId]))[0].id;
  const license = (await live.owner<{ id: string }>(`SELECT id FROM registry.practice_licenses WHERE entity_id = $1 AND kind = 'master_lease'`, [w.beichen.entityId]))[0].id;
  await live.owner(`UPDATE registry.practice_licenses SET permit_no = '北市租管字第0001號' WHERE id = $1`, [license]);
  const reviewItems = { license: newUlid(), certificate: newUlid(), employment: newUlid() };
  await live.owner(`INSERT INTO registry.review_items (id, type, subject_type, subject_id) VALUES ($1, 'license', 'license', $2)`, [reviewItems.license, license]);
  await live.owner(`INSERT INTO registry.review_items (id, type, subject_type, subject_id) VALUES ($1, 'certificate', 'practitioner', $2)`, [reviewItems.certificate, chenPractitioner]);
  await live.owner(`INSERT INTO registry.review_items (id, type, subject_type, subject_id) VALUES ($1, 'employment', 'employment', $2)`, [reviewItems.employment, w.xu.employmentId]);

  const people = [...Object.values(w.beichen.people), ...Object.values(w.yunding.people), ...Object.values(w.xinghe.people)];
  const key = (serial: string) => `rental_housing_manager:112:內授營:${serial}`;
  const fixture: DisclosureFixture = {
    entityId: w.beichen.entityId,
    partyIds: Object.values(w.beichen.people).map((p) => p.partyId),
    practitionerId: chenPractitioner,
    employmentIds: { active: w.chen.employmentId, pending: w.wu.employmentId, lapsed: w.xu.employmentId },
    certificateKeys: { active: key('1234567'), lapsed: key('2000004') },
    reviewItems,
    entityIds: [w.beichen.entityId, w.yunding.entityId, w.xinghe.entityId],
    membershipId: w.beichen.people.wang.membershipId,
  };

  return {
    live,
    fixture,
    operatorUserId,
    unrelatedPracticeOrgId,
    members,
    sentinels: {
      certificateNo: ['1234567', '2000001', '2000002', '2000003', '2000004', '3000001', '3000002', '4000001'],
      fullEmail: people.map((p) => p.email),
      taxId: ['11111111', '22222222', '33333333'],
      checkId: Object.values(w.checks),
      // 待驗證、證書失效、任職已結束的任職 ID，以及已結束任職的結束日（沒有回任職 ID 的函式靠它偵測）
      inactiveEmployment: [w.wu.employmentId, w.zhou.employmentId, w.xu.employmentId, '2026-09-01'],
    },
    close: () => live.close(),
  };
}

// ---------------------------------------------------------------------------
// 呼叫與觀察

export type Outcome = { status: 'denied' } | { status: 'ok'; fields: PiiField[]; text: string };

const PII_ORDER: readonly PiiField[] = ['certificateNo', 'fullEmail', 'taxId', 'checkId', 'inactiveEmployment'];

/** 回應文字裡出現了哪些個資欄位。 */
export function exposedFields(text: string, sentinels: DisclosureWorld['sentinels']): PiiField[] {
  return PII_ORDER.filter((field) => sentinels[field].some((s) => text.includes(s)));
}

/** 在某個脈絡呼叫，把結果歸成「被拒」或「成功加上含哪些個資欄位」。42501 以外的錯誤原樣丟出。 */
export async function observe(
  world: DisclosureWorld,
  ctx: DbContext,
  call: (tx: OrgTx) => Promise<unknown>,
): Promise<Outcome> {
  try {
    const result = await withTx(ctx, (tx) => call(tx as OrgTx));
    const text = JSON.stringify(result);
    return { status: 'ok', fields: exposedFields(text, world.sentinels), text };
  } catch (error) {
    if ((error as { code?: string }).code === '42501') return { status: 'denied' };
    throw error;
  }
}

/** 探測對象：真實的，或同種類但不存在的。 */
export function subjectFor(fx: DisclosureFixture, subject: DisclosureSubject | undefined, real: boolean): string {
  switch (subject) {
    case 'entity':
      return real ? fx.entityId : newUlid();
    case 'employment':
      return real ? fx.employmentIds.lapsed : newUlid();
    case 'certificateKey':
      return real ? fx.certificateKeys.lapsed : 'rental_housing_manager:112:內授營:9999999';
    case 'membership':
      return real ? fx.membershipId : newUlid();
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// 呼叫者自己建立關係

export interface Attacker {
  orgId: string;
  partyId: string;
  ctx: DbContext;
}

async function newAttacker(world: DisclosureWorld, kind: 'owner' | 'practice', name: string): Promise<Attacker> {
  const orgId = newUlid();
  await world.live.owner(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, $2, $3)`, [orgId, name, kind]);
  const partyId = await addMember(world.live, orgId, name);
  return { orgId, partyId, ctx: { kind: 'org', orgId, partyId } };
}

/** 新開一個執業主體組織，沒有任何綁定。 */
export const attackerPracticeOrg = (world: DisclosureWorld) => newAttacker(world, 'practice', '攻擊者的執業主體組織');

let attackerTaxId = 90_000_000;

/**
 * 新開一個執業主體組織，並登錄它的執業主體（MIL-186）。有執業主體才走得到專任判定的寫入路徑。
 * 這是呼叫者自己能建立的關係：任何人都能送出執業主體登錄，審核之前業別是待驗證。
 */
export async function attackerPracticeOrgWithEntity(world: DisclosureWorld): Promise<Attacker> {
  const a = await attackerPracticeOrg(world);
  attackerTaxId += 1;
  await world.live.owner(`INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, $2, $3, 'company', $4)`, [
    newUlid(),
    String(attackerTaxId),
    '攻擊者的執業主體',
    a.orgId,
  ]);
  return a;
}

/** 新開一個屋主組織並建一份草稿合約：關係是 selecting。回傳可以再存指派的合約 ID。 */
export async function attackerDraftOwner(world: DisclosureWorld): Promise<Attacker & { contractId: string }> {
  const a = await newAttacker(world, 'owner', '攻擊者的屋主組織');
  const contractId = await withTx({ kind: 'org', orgId: a.orgId }, (tx) =>
    createContract(tx as OrgTx, { property_id: null, fields: {} as never }),
  );
  return { ...a, contractId };
}

/** 在草稿合約上存一筆指派，指向北辰與已驗證的專任管理人員：關係變成 bound。 */
export async function attackerAssign(world: DisclosureWorld, a: Attacker & { contractId: string }): Promise<void> {
  const w = world.live.world;
  await withTx({ kind: 'org', orgId: a.orgId }, (tx) =>
    replaceAssignments(tx as OrgTx, a.contractId, [{ slot: 'a', entityId: w.beichen.entityId, practitionerId: w.chen.employmentId, partySignerId: null }]),
  );
}

/** 新開一個屋主組織，建案件並把北辰成員的 party 加為案件成員：關係是 bound（案件成員）。 */
export async function attackerCaseOwner(world: DisclosureWorld): Promise<Attacker> {
  const a = await newAttacker(world, 'owner', '攻擊者的案件屋主');
  const caseId = newUlid();
  await withTx({ kind: 'org', orgId: a.orgId }, async (tx) => {
    await tx.query(`INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', 'draft', 'master_lease', '攻擊案件')`, [caseId, a.orgId]);
    await tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'practitioner')`, [
      newUlid(),
      a.orgId,
      caseId,
      world.live.world.beichen.people.chen.partyId,
    ]);
  });
  return a;
}

/**
 * 用別人的證號，替攻擊者自己登錄一筆待審證書。證書鍵與北辰人員的相同，序號取自證書鍵。
 * 這是呼叫者自己能建立的關係：任何執業主體組織的成員都能送件，審核之前狀態是待驗證。
 */
export async function attackerRegisterCertificate(world: DisclosureWorld, a: Attacker, certificateKey: string): Promise<void> {
  const [kind, year, word, serial] = certificateKey.split(':');
  await world.live.owner(
    `INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2023-03-01', '2029-12-31', 'pending')`,
    [newUlid(), a.partyId, kind, year, word, serial, certificateKey],
  );
}
