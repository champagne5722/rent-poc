// 真實 adapter 的測試資料（MIL-113）：真的 migration、app_rw 連線（PGlite）。
// 世界的內容對應 seed adapter 的假資料，讓同一組契約測試能對兩個 adapter 跑。

import { createContract, getContract } from '../contracts/repository';
import { replaceAssignments } from '../practitioner-assignment/repository';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { createLivePracticeRegistry, type RegistryRunner } from './live-adapter';
import type { PracticeRegistry } from './types';

export const LIVE_AT = '2026-11-09T12:00:00+08:00';
export const LIVE_NOW = () => new Date(LIVE_AT);

interface PersonSpec {
  key: string;
  name: string;
  email: string;
}

export interface LivePerson {
  partyId: string;
  userId: string;
  membershipId: string;
  email: string;
  name: string;
}

export interface LiveEntity {
  entityId: string;
  orgId: string;
  people: Record<string, LivePerson>;
}

export interface LiveWorld {
  beichen: LiveEntity;
  yunding: LiveEntity;
  xinghe: LiveEntity;
  /** 北辰的專任管理人員 */
  chen: { employmentId: string; certificateNo: string };
  lin: { employmentId: string };
  wu: { employmentId: string };
  zhou: { employmentId: string };
  xu: { employmentId: string };
  zhao: { employmentId: string };
  sun: { employmentId: string };
  xing: { employmentId: string };
  /** 草稿合約的指派指向北辰與雲頂：關係是 bound */
  boundOrgId: string;
  /** 有草稿合約但沒有任何綁定：關係是 selecting */
  selectingOrgId: string;
  /** 沒有合約也沒有綁定：關係是 none */
  unrelatedOrgId: string;
  /** 沒有草稿合約，但有案件成員屬於北辰：關係是 bound */
  caseBoundOrgId: string;
  /** 北辰三層與業別各一筆核對紀錄 ID */
  checks: { license: string; practitioner: string; employment: string };
}

export interface LiveKit {
  kit: RouteDb;
  world: LiveWorld;
  /** 在某個組織內開短交易的執行器。 */
  runnerFor(orgId: string, partyId?: string): RegistryRunner;
  registryAs(orgId: string, partyId?: string): PracticeRegistry;
  owner<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export async function setupLiveKit(): Promise<LiveKit> {
  const kit = await setupRouteDb();
  await kit.reset();
  const owner = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    kit.asOwner(async (db) => (await db.query(sql, params)).rows as T[]);

  async function person(orgId: string, spec: PersonSpec, role = 'staff'): Promise<LivePerson> {
    const partyId = newUlid();
    const userId = newUlid();
    const membershipId = newUlid();
    await owner('INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)', [partyId, spec.email, spec.name]);
    await owner('INSERT INTO control.users (id, party_id) VALUES ($1, $2)', [userId, partyId]);
    await owner('INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)', [membershipId, orgId, userId, role]);
    return { partyId, userId, membershipId, email: spec.email, name: spec.name };
  }

  async function entity(
    name: string,
    taxId: string,
    licenses: Array<[kind: string, state: string]>,
    specs: PersonSpec[],
  ): Promise<LiveEntity> {
    const orgId = newUlid();
    const entityId = newUlid();
    await owner(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, $2, 'practice')`, [orgId, name]);
    await owner(`INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, $2, $3, 'company', $4)`, [
      entityId,
      taxId,
      name,
      orgId,
    ]);
    for (const [kind, state] of licenses) {
      await owner('INSERT INTO registry.practice_licenses (id, entity_id, kind, state) VALUES ($1, $2, $3, $4)', [newUlid(), entityId, kind, state]);
    }
    const people: Record<string, LivePerson> = {};
    for (const spec of specs) people[spec.key] = await person(orgId, spec);
    return { entityId, orgId, people };
  }

  /** 一位人員的證書與任職。回傳任職 ID。 */
  async function credential(
    who: LivePerson,
    entityId: string,
    options: {
      kind: string;
      serial: string;
      certState: string;
      validUntil: string;
      employmentState: string;
      startedOn?: string;
      endedOn?: string | null;
    },
  ): Promise<string> {
    const practitionerId = newUlid();
    const employmentId = newUlid();
    const key = `${options.kind}:112:內授營:${options.serial}`;
    await owner(
      `INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until, state)
       VALUES ($1, $2, $3, '112', '內授營', $4, $5, '2023-03-01', $6, $7)`,
      [practitionerId, who.partyId, options.kind, options.serial, key, options.validUntil, options.certState],
    );
    await owner(
      `INSERT INTO registry.practitioner_employments (id, practitioner_id, certificate_key, certificate_kind, entity_id, state, started_on, ended_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [employmentId, practitionerId, key, options.kind, entityId, options.employmentState, options.startedOn ?? '2024-01-01', options.endedOn ?? null],
    );
    return employmentId;
  }

  const slug = (s: string) => `${s}@example.com`;
  const beichen = await entity(
    '北辰租賃住宅管理股份有限公司',
    '11111111',
    [
      ['management', 'verified'],
      ['master_lease', 'verified'],
    ],
    [
      { key: 'wang', name: '王建國', email: slug('wang.jianguo') },
      { key: 'li', name: '李淑芬', email: slug('li.shufen') },
      { key: 'chen', name: '陳怡君', email: slug('chen.yijun') },
      { key: 'lin', name: '林志豪', email: slug('lin.zhihao') },
      { key: 'wu', name: '吳家豪', email: slug('wu.jiahao') },
      { key: 'zhou', name: '周大衛', email: slug('zhou.dawei') },
      { key: 'xu', name: '許文傑', email: slug('xu.wenjie') },
    ],
  );
  const yunding = await entity('雲頂不動產經紀有限公司', '22222222', [['brokerage', 'verified']], [
    { key: 'zhao', name: '趙經紀', email: slug('zhao.jingji') },
    { key: 'sun', name: '孫小美', email: slug('sun.xiaomei') },
  ]);
  const xinghe = await entity('星河租賃住宅管理有限公司', '33333333', [['management', 'pending']], [
    { key: 'xing', name: '邢雅芳', email: slug('xing.yafang') },
  ]);

  const rhm = 'rental_housing_manager';
  const p = beichen.people;
  const chenEmployment = await credential(p.chen, beichen.entityId, { kind: rhm, serial: '1234567', certState: 'verified', validUntil: '2029-12-31', employmentState: 'verified' });
  const world: LiveWorld = {
    beichen,
    yunding,
    xinghe,
    chen: { employmentId: chenEmployment, certificateNo: '112年內授營字第1234567號' },
    // 證書 3 個月後期滿：在換證窗口內，仍可簽章
    lin: { employmentId: await credential(p.lin, beichen.entityId, { kind: rhm, serial: '2000001', certState: 'verified', validUntil: '2027-02-09', employmentState: 'verified' }) },
    // 任職還在待驗證：不是專任，也不可簽章
    wu: { employmentId: await credential(p.wu, beichen.entityId, { kind: rhm, serial: '2000002', certState: 'verified', validUntil: '2029-12-31', employmentState: 'pending' }) },
    // 證書已失效
    zhou: { employmentId: await credential(p.zhou, beichen.entityId, { kind: rhm, serial: '2000003', certState: 'lapsed', validUntil: '2028-12-31', employmentState: 'verified' }) },
    // 任職已結束
    xu: { employmentId: await credential(p.xu, beichen.entityId, { kind: rhm, serial: '2000004', certState: 'verified', validUntil: '2029-12-31', employmentState: 'lapsed', endedOn: '2026-09-01' }) },
    zhao: { employmentId: await credential(yunding.people.zhao, yunding.entityId, { kind: 'real_estate_broker', serial: '3000001', certState: 'verified', validUntil: '2029-12-31', employmentState: 'verified' }) },
    sun: { employmentId: await credential(yunding.people.sun, yunding.entityId, { kind: 'real_estate_sales_agent', serial: '3000002', certState: 'verified', validUntil: '2029-12-31', employmentState: 'verified' }) },
    xing: { employmentId: await credential(xinghe.people.xing, xinghe.entityId, { kind: rhm, serial: '4000001', certState: 'verified', validUntil: '2029-12-31', employmentState: 'verified' }) },
    boundOrgId: newUlid(),
    selectingOrgId: newUlid(),
    unrelatedOrgId: newUlid(),
    caseBoundOrgId: newUlid(),
    checks: { license: newUlid(), practitioner: newUlid(), employment: newUlid() },
  };

  for (const [orgId, name] of [
    [world.boundOrgId, '綁定的屋主'],
    [world.selectingOrgId, '選人中的屋主'],
    [world.unrelatedOrgId, '無關的屋主'],
    [world.caseBoundOrgId, '案件綁定的屋主'],
  ]) {
    await owner(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, $2, 'owner')`, [orgId, name]);
  }

  const draft = (orgId: string, assign: Array<[slot: string, entityId: string, practitionerId: string]>) =>
    withTx({ kind: 'org', orgId }, async (tx) => {
      const id = await createContract(tx as OrgTx, { property_id: null, fields: {} as never });
      if (!(await getContract(tx as OrgTx, id))) throw new Error('建立草稿合約失敗');
      await replaceAssignments(tx as OrgTx, id, assign.map(([slot, entityId, practitionerId]) => ({ slot, entityId, practitionerId, partySignerId: null })));
    });
  await draft(world.boundOrgId, [
    ['a', beichen.entityId, chenEmployment],
    ['b', yunding.entityId, world.zhao.employmentId],
    ['c', xinghe.entityId, world.xing.employmentId],
  ]);
  await draft(world.selectingOrgId, []);

  // 案件綁定：屋主組織的案件，成員是北辰的專任管理人員（relation = practitioner）
  const caseId = newUlid();
  await withTx({ kind: 'org', orgId: world.caseBoundOrgId }, async (tx) => {
    await tx.query(`INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', 'draft', 'master_lease', '測試案件')`, [caseId, world.caseBoundOrgId]);
    await tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'practitioner')`, [
      newUlid(),
      world.caseBoundOrgId,
      caseId,
      p.chen.partyId,
    ]);
  });

  // 核對紀錄：業別、證書、任職各一筆。稽核欄位是必填，測試填佔位值
  const licenseRow = await owner<{ id: string }>(`SELECT id FROM registry.practice_licenses WHERE entity_id = $1 AND kind = 'master_lease'`, [beichen.entityId]);
  const practitionerRow = await owner<{ id: string }>(`SELECT id FROM registry.practitioners WHERE party_id = $1`, [p.chen.partyId]);
  for (const [id, type, subject] of [
    [world.checks.license, 'license', licenseRow[0].id],
    [world.checks.practitioner, 'practitioner', practitionerRow[0].id],
    [world.checks.employment, 'employment', chenEmployment],
  ]) {
    await owner(
      `INSERT INTO registry.credential_checks (id, subject_type, subject_id, channel, query_source, result, checked_by, audit_chain_id, audit_seq)
       VALUES ($1, $2, $3, 'resim_manual', '測試', 'match', 'tester', 'test-chain', 1)`,
      [id, type, subject],
    );
  }

  const runnerFor = (orgId: string, partyId?: string): RegistryRunner => (fn) =>
    withTx({ kind: 'org', orgId, ...(partyId ? { partyId } : {}) }, (tx) => fn(tx as OrgTx));
  return {
    kit,
    world,
    runnerFor,
    registryAs: (orgId, partyId) => createLivePracticeRegistry({ run: runnerFor(orgId, partyId), now: LIVE_NOW }),
    owner,
    close: () => kit.close(),
  };
}
