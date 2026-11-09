import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_ORG_ID } from '../auth/config';
import { withTx } from '../pg/database';
import type { OrgTx } from '../pg/with-tx';
import { newUlid } from '../pg/ulid';
import { pdf, setupPracticeKit, type Account, type PracticeKit } from '../practice-entities/test-kit';
import {
  createEmploymentFlow,
  endEmploymentFlow,
  getCertificateBadges,
  getCredentialReview,
  getMyPractitioner,
  getSigningFacts,
  listOrgEmployments,
  recordConsentFlow,
  recordCredentialCheckFlow,
  registerCertificateFlow,
  submitConsentLetterFlow,
} from './index';

// MIL-111：證書登錄、任職、專任規則、審核台核對、查詢。真實 migration、app_rw 連線、本機 FileStore、mock 寄信。

let t: PracticeKit;
beforeAll(async () => {
  t = await setupPracticeKit();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const certForm = (over: Record<string, unknown> = {}) => ({
  certificateKind: 'rental_housing_manager',
  certYear: '112',
  certWord: '內授營',
  certSerial: '123456',
  issuedOn: '2024-03-01',
  validUntil: '2028-03-01',
  files: [pdf('證書.pdf')],
  ...over,
});
const checkForm = (over: Record<string, unknown> = {}) => ({
  channel: 'resim_manual',
  querySource: 'resim 證書查詢',
  result: 'match',
  note: '',
  validUntil: '2028-03-01',
  ...over,
});

const agree = (a: Account) => recordConsentFlow(a, { decision: 'agree' });
const register = async (a: Account, over: Record<string, unknown> = {}) => {
  await agree(a);
  return registerCertificateFlow(a, certForm(over), t.deps);
};
const mine = (a: Account) => withTx({ kind: 'org', orgId: a.orgId, partyId: a.partyId }, (tx) => getMyPractitioner(tx));

/** 同一個人也是另一個執業主體組織的成員（換公司、兼職的前提）。 */
async function joinOrg(person: Account, org: Account): Promise<Account> {
  await t.registry('INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)', [newUlid(), org.orgId, person.userId, 'staff']);
  return { ...org, userId: person.userId, partyId: person.partyId, role: 'staff' };
}

async function openItem(type: string, subjectId: string): Promise<string> {
  const rows = await t.registry<{ id: string }>(`SELECT id FROM registry.review_items WHERE type = $1 AND subject_id = $2 AND status = 'open'`, [type, subjectId]);
  return rows[0].id;
}
const certOf = async (a: Account) =>
  (await t.registry<{ id: string; state: string; valid_until: string }>(`SELECT id, state, valid_until::text FROM registry.practitioners WHERE party_id = $1`, [a.partyId]))[0];
const employmentsOf = (orgId: string) =>
  t.registry<{ id: string; state: string; consent_required: boolean }>(
    `SELECT m.id, m.state, m.consent_required FROM registry.practitioner_employments m JOIN registry.practice_entities e ON e.id = m.entity_id WHERE e.org_id = $1 ORDER BY m.created_at`,
    [orgId],
  );
const auditOf = (orgId: string) =>
  withTx({ kind: 'org', orgId }, async (tx) => (await tx.query<{ action: string; payload: Record<string, unknown> }>('SELECT action, payload FROM audit.events ORDER BY seq')).rows);

/** 營運者核對證書與任職，回傳兩個流程結果。 */
async function verifyBoth(a: Account) {
  const op = await t.operatorAccount();
  const cert = await certOf(a);
  const [emp] = await employmentsOf(a.orgId);
  const certResult = await recordCredentialCheckFlow(op.run, await openItem('certificate', cert.id), checkForm(), t.deps);
  const empResult = await recordCredentialCheckFlow(op.run, await openItem('employment', emp.id), checkForm({ validUntil: '' }), t.deps);
  return { op, cert, emp, certResult, empResult };
}

describe('證書登錄頁：告知與同意（P0-24 AC3）', () => {
  it('還沒同意個資告知時擋下，同意後才能登錄；同意紀錄存目前版本', async () => {
    const a = await t.practiceAccount('a@example.com');
    expect(await registerCertificateFlow(a, certForm(), t.deps)).toEqual({ status: 'consent_required' });
    expect(t.storeFiles()).toEqual([]);

    expect(await agree(a)).toEqual({ status: 'recorded', decision: 'agree' });
    expect(await registerCertificateFlow(a, certForm(), t.deps)).toMatchObject({ status: 'registered' });

    const records = await withTx({ kind: 'org', orgId: a.orgId }, async (tx) =>
      (await tx.query<{ notice_type: string; notice_version: number; decision: string }>('SELECT notice_type, notice_version, decision FROM org.consent_records')).rows,
    );
    expect(records).toEqual([{ notice_type: 'certificate_pii', notice_version: 1, decision: 'agree' }]);
  });

  it('反對告知時不能登錄', async () => {
    const a = await t.practiceAccount('a@example.com');
    await recordConsentFlow(a, { decision: 'object' });
    expect(await registerCertificateFlow(a, certForm(), t.deps)).toEqual({ status: 'consent_required' });
  });
});

describe('登錄證書與待驗證任職', () => {
  it('證書與任職都是待驗證；影本放 vault；稽核事件不含證號', async () => {
    const a = await t.practiceAccount('a@example.com');
    const result = await register(a);
    expect(result).toMatchObject({ status: 'registered', employment: { status: 'created', consentRequired: false, notice: null }, validUntilHint: null });

    const state = await mine(a);
    expect(state.certificates[0]).toMatchObject({ kind: 'rental_housing_manager', state: 'pending', phase: 'awaiting_review', number: { year: '112', word: '內授營', serial: '123456' } });
    expect(state.employments[0]).toMatchObject({ state: 'pending', phase: 'awaiting_review', consentRequired: false, consentedByEntity: false });

    const evidence = await t.registry<{ subject_type: string; org_id: string; object_key: string }>('SELECT subject_type, org_id, object_key FROM vault.credential_evidence');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ subject_type: 'practitioner', org_id: a.orgId });
    expect(evidence[0].object_key).toMatch(new RegExp(`^org/${a.orgId}/vault/credential-evidence/[0-9A-Z]{26}\\.pdf$`));
    expect(await t.store.exists(evidence[0].object_key as never)).toBe(true);

    const events = await auditOf(a.orgId);
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['consent.record', 'vault.upload', 'practitioner.submit', 'employment.create']));
    expect(JSON.stringify(events.filter((e) => /^(practitioner|employment|vault)\./.test(e.action)))).not.toMatch(/123456|內授營/);
  });

  it('審核台佇列多出證書與任職兩個項目', async () => {
    const a = await t.practiceAccount('a@example.com');
    await register(a);
    const rows = await t.registry<{ type: string }>(`SELECT type FROM registry.review_items WHERE type IN ('certificate', 'employment') AND status = 'open' ORDER BY type`);
    expect(rows.map((r) => r.type)).toEqual(['certificate', 'employment']);
  });

  it('欄位缺漏時什麼都不寫：沒有證書、沒有任職、沒有影本', async () => {
    const a = await t.practiceAccount('a@example.com');
    await agree(a);
    expect(await registerCertificateFlow(a, certForm({ certSerial: '' }), t.deps)).toMatchObject({ status: 'invalid', field: 'certSerial' });
    expect(await registerCertificateFlow(a, certForm({ files: [] }), t.deps)).toMatchObject({ status: 'invalid', field: 'files' });
    expect(await t.registry('SELECT 1 FROM registry.practitioners')).toHaveLength(0);
    expect(await t.registry('SELECT 1 FROM vault.credential_evidence')).toHaveLength(0);
    expect(t.storeFiles()).toEqual([]);
  });

  it('效期與發證日加 4 年不一致時提示，但不阻擋', async () => {
    const a = await t.practiceAccount('a@example.com');
    const result = await register(a, { validUntil: '2027-03-01' });
    expect(result).toMatchObject({ status: 'registered', validUntilHint: expect.stringContaining('2028-03-01') });
  });

  it('屋主組織不能登錄證書', async () => {
    const a = await t.practiceAccount('a@example.com');
    expect(await registerCertificateFlow({ ...a, orgKind: 'owner' }, certForm(), t.deps)).toEqual({ status: 'forbidden' });
  });

  it('只能登錄自己的證書：別人的帳號在這個組織脈絡下被資料庫拒絕', async () => {
    const a = await t.practiceAccount('a@example.com');
    const b = await t.practiceAccount('b@example.com', { name: '乙公司', taxId: '22222222' });
    // b 不是 a 組織的成員。即使程式傳入 a 的組織，資料庫也查成員資格
    await expect(
      withTx({ kind: 'org', orgId: a.orgId, partyId: b.partyId }, (tx) =>
        tx.query('SELECT * FROM registry.submit_practitioner($1, $2, $3, $4, $5, $6::date, $7::date, NULL, $8, $9)', [
          newUlid(), 'rental_housing_manager', '112', '內授營', '999999', '2024-03-01', '2028-03-01', 'pending', newUlid(),
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('審核台核對', () => {
  it('證書相符：效期以營運者登錄的為準，影本刪除（檔案與中繼資料），核對紀錄寫稽核事件', async () => {
    const a = await t.practiceAccount('a@example.com');
    await register(a, { validUntil: '2027-03-01' });
    const op = await t.operatorAccount();
    const cert = await certOf(a);

    const result = await recordCredentialCheckFlow(op.run, await openItem('certificate', cert.id), checkForm({ validUntil: '2028-06-30' }), t.deps);
    expect(result).toMatchObject({ status: 'recorded', from: 'pending', to: 'verified', result: 'match', supplement: null });

    expect(await certOf(a)).toMatchObject({ state: 'verified', valid_until: '2028-06-30' });
    expect(t.storeFiles()).toEqual([]);
    const evidence = await t.registry<{ state: string; delete_reason: string; file_removed_at: string | null }>('SELECT state, delete_reason, file_removed_at FROM vault.credential_evidence');
    expect(evidence[0]).toMatchObject({ state: 'deleted', delete_reason: 'matched' });
    expect(evidence[0].file_removed_at).not.toBeNull();

    const checks = await t.registry<{ subject_type: string; result: string; audit_chain_id: string }>('SELECT subject_type, result, audit_chain_id FROM registry.credential_checks');
    expect(checks).toMatchObject([{ subject_type: 'practitioner', result: 'match' }]);
    const platform = await auditOf(PLATFORM_ORG_ID);
    expect(platform.map((e) => e.action)).toEqual(expect.arrayContaining(['practitioner.verify', 'vault.delete']));
    expect((await mine(a)).certificates[0]).toMatchObject({ state: 'verified', phase: 'verified', validUntil: '2028-06-30' });
  });

  it('相符時必須登錄效期；不是相符時必須寫判定理由', async () => {
    const a = await t.practiceAccount('a@example.com');
    await register(a);
    const op = await t.operatorAccount();
    const itemId = await openItem('certificate', (await certOf(a)).id);
    expect(await recordCredentialCheckFlow(op.run, itemId, checkForm({ validUntil: '' }), t.deps)).toMatchObject({ status: 'invalid', field: 'validUntil' });
    expect(await recordCredentialCheckFlow(op.run, itemId, checkForm({ result: 'not_found', note: '' }), t.deps)).toMatchObject({ status: 'invalid', field: 'note' });
    expect((await certOf(a)).state).toBe('pending');
  });

  it('查無該證號：維持待驗證，影本保留，執業人員看到補件原因並收到信（P0-04 AC2）', async () => {
    const a = await t.practiceAccount('a@example.com');
    await register(a);
    const op = await t.operatorAccount();
    const cert = await certOf(a);
    const result = await recordCredentialCheckFlow(op.run, await openItem('certificate', cert.id), checkForm({ result: 'not_found', note: 'resim 查無此證號，請確認證號' }), t.deps);
    expect(result).toMatchObject({ status: 'recorded', from: 'pending', to: 'pending', result: 'not_found' });

    expect((await certOf(a)).state).toBe('pending');
    expect(t.storeFiles()).toHaveLength(1);
    expect((await mine(a)).certificates[0]).toMatchObject({ phase: 'needs_resubmission', lastResult: 'not_found', lastNote: 'resim 查無此證號，請確認證號' });
    const mail = t.mailer.sent.at(-1)!;
    expect(mail).toMatchObject({ to: 'a@example.com', kind: 'registry.practitioner_supplement_requested' });
    expect(mail.text).toContain('resim 查無此證號');
    expect(mail.text).not.toContain('123456');

    // 補件：更正證號後重送，回到待核對，仍然只有一個待核對項目
    expect(await registerCertificateFlow(a, certForm({ certSerial: '654321' }), t.deps)).toMatchObject({ status: 'registered', employment: null });
    expect((await mine(a)).certificates[0]).toMatchObject({ phase: 'awaiting_review', number: { serial: '654321' } });
    expect(await t.registry(`SELECT 1 FROM registry.review_items WHERE type = 'certificate' AND status = 'open'`)).toHaveLength(1);
  });

  it('已經核對過的項目不能重複登錄', async () => {
    const a = await t.practiceAccount('a@example.com');
    await register(a);
    const op = await t.operatorAccount();
    const itemId = await openItem('certificate', (await certOf(a)).id);
    await recordCredentialCheckFlow(op.run, itemId, checkForm(), t.deps);
    expect(await recordCredentialCheckFlow(op.run, itemId, checkForm(), t.deps)).toEqual({ status: 'already_resolved' });
  });

  it('任職相符：任職轉已驗證；與證書層各自獨立，不受核對順序限制（ADR-0017 決議 6）', async () => {
    const a = await t.practiceAccount('a@example.com');
    await register(a);
    const op = await t.operatorAccount();
    const [emp] = await employmentsOf(a.orgId);
    const result = await recordCredentialCheckFlow(op.run, await openItem('employment', emp.id), checkForm({ validUntil: '' }), t.deps);
    expect(result).toMatchObject({ status: 'recorded', to: 'verified' });
    const state = await mine(a);
    expect(state.employments[0]).toMatchObject({ state: 'verified', phase: 'verified' });
    expect(state.certificates[0].state).toBe('pending');
  });
});

describe('專任規則（P0-05）', () => {
  it('AC1：管理人員在別家已有已驗證在職時阻擋，訊息固定，不顯示別家，什麼都不建', async () => {
    const a = await t.practiceAccount('a@example.com');
    const b = await t.practiceAccount('b@example.com', { name: '乙公司', taxId: '22222222' });
    await register(a);
    await verifyBoth(a);

    const result = await register(b);
    expect(result).toEqual({ status: 'blocked', message: '此證號已有在職紀錄' });
    expect(JSON.stringify(result)).not.toMatch(/安心代管|12345678/);
    expect(await employmentsOf(b.orgId)).toHaveLength(0);
    expect(await t.registry('SELECT 1 FROM registry.practitioners WHERE party_id = $1', [b.partyId])).toHaveLength(0);
    expect(await t.registry(`SELECT 1 FROM vault.credential_evidence WHERE org_id = $1`, [b.orgId])).toHaveLength(0);
    expect(t.storeFiles().filter((f) => f.includes(b.orgId))).toEqual([]);
  });

  it('AC6：每次阻擋寫稽核事件，含證號、時間、原因，在宣稱方自己的鏈，不含別家資料', async () => {
    const a = await t.practiceAccount('a@example.com');
    const b = await t.practiceAccount('b@example.com', { name: '乙公司', taxId: '22222222' });
    await register(a);
    await verifyBoth(a);
    await register(b);

    const blocked = (await auditOf(b.orgId)).filter((e) => e.action === 'rule.full_time_block');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].payload).toMatchObject({ reason: 'exclusive_employment_elsewhere', certificate_number: '112年內授營字第123456號', at: expect.any(String) });
    expect(JSON.stringify(blocked)).not.toContain(a.orgId);
    expect((await auditOf(a.orgId)).filter((e) => e.action === 'rule.full_time_block')).toHaveLength(0);
  });

  it('AC6（換公司）：被擋時稽核事件也留在宣稱方的鏈，什麼都不建，每次被擋各一筆（MIL-186）', async () => {
    const a = await t.practiceAccount('a@example.com');
    const b = await t.practiceAccount('b@example.com', { name: '乙公司', taxId: '22222222' });
    await register(a);
    await verifyBoth(a);
    const bAsPerson = await joinOrg(a, b);
    await agree(bAsPerson);
    const cert = await certOf(a);

    const blocked = { status: 'blocked', message: '此證號已有在職紀錄' };
    expect(await createEmploymentFlow(bAsPerson, { certificateId: cert.id }, t.deps)).toEqual(blocked);
    expect(await createEmploymentFlow(bAsPerson, { certificateId: cert.id }, t.deps)).toEqual(blocked);

    expect(await employmentsOf(b.orgId)).toHaveLength(0);
    const events = (await auditOf(b.orgId)).filter((e) => e.action === 'rule.full_time_block');
    expect(events).toHaveLength(2);
    expect(events[0].payload).toMatchObject({ event: 'employment_blocked', reason: 'exclusive_employment_elsewhere', certificate_number: '112年內授營字第123456號', at: expect.any(String) });
    expect(JSON.stringify(events)).not.toContain(a.orgId);
    expect((await auditOf(a.orgId)).filter((e) => e.action === 'rule.full_time_block')).toHaveLength(0);
  });

  it('別家只有待驗證時允許並存；營運者核對第一家相符後，第二家被擋，直到第一家離職', async () => {
    const a = await t.practiceAccount('a@example.com');
    const b = await t.practiceAccount('b@example.com', { name: '乙公司', taxId: '22222222' });
    await register(a);
    expect(await register(b)).toMatchObject({ status: 'registered', employment: { status: 'created' } });
    expect((await employmentsOf(b.orgId))[0].state).toBe('pending');

    const op = await t.operatorAccount();
    const [empA] = await employmentsOf(a.orgId);
    const [empB] = await employmentsOf(b.orgId);
    // 審核台看得到同一證號的另一家，讓營運者判定哪一家相符
    const detail = await op.run('desk:t', async (tx) => getCredentialReview(tx, await openItem('employment', empA.id)));
    expect(detail?.competing).toMatchObject([{ entityName: '乙公司', state: 'pending' }]);
    expect(await recordCredentialCheckFlow(op.run, await openItem('employment', empA.id), checkForm({ validUntil: '' }), t.deps)).toMatchObject({ status: 'recorded', to: 'verified' });

    const itemB = await openItem('employment', empB.id);
    const blocked = await recordCredentialCheckFlow(op.run, itemB, checkForm({ validUntil: '' }), t.deps);
    expect(blocked).toEqual({ status: 'exclusivity_blocked', message: expect.stringContaining('resim') });
    expect((await employmentsOf(b.orgId))[0].state).toBe('pending');
    const platformEvents = (await auditOf(PLATFORM_ORG_ID)).filter((e) => e.action === 'rule.full_time_block');
    expect(platformEvents.some((e) => e.payload.certificate_number === '112年內授營字第123456號')).toBe(true);

    // A 離職後，B 可以核對相符
    await endEmploymentFlow(a, empA.id, { endedOn: '2026-11-09' }, t.deps);
    expect(await recordCredentialCheckFlow(op.run, itemB, checkForm({ validUntil: '' }), t.deps)).toMatchObject({ status: 'recorded', to: 'verified' });
  });

  it('資料庫排除約束：同一證號不能有兩筆已驗證的管理人員任職，繞過應用程式也一樣', async () => {
    const a = await t.practiceAccount('a@example.com');
    const b = await t.practiceAccount('b@example.com', { name: '乙公司', taxId: '22222222' });
    await register(a);
    await register(b);
    const [empA] = await employmentsOf(a.orgId);
    const [empB] = await employmentsOf(b.orgId);
    await t.registry(`UPDATE registry.practitioner_employments SET state = 'verified' WHERE id = $1`, [empA.id]);
    await expect(t.registry(`UPDATE registry.practitioner_employments SET state = 'verified' WHERE id = $1`, [empB.id])).rejects.toMatchObject({ code: '23505' });
  });

  it('AC2：舊任職離職後，同一個人在新公司建立待驗證任職；證書層沿用，不用再核', async () => {
    const a = await t.practiceAccount('a@example.com');
    const b = await t.practiceAccount('b@example.com', { name: '乙公司', taxId: '22222222' });
    await register(a);
    const { emp } = await verifyBoth(a);
    const bAsPerson = await joinOrg(a, b);
    await agree(bAsPerson);

    const cert = await certOf(a);
    // 在職時換公司被擋
    expect(await createEmploymentFlow(bAsPerson, { certificateId: cert.id }, t.deps)).toEqual({ status: 'blocked', message: '此證號已有在職紀錄' });
    expect(await employmentsOf(b.orgId)).toHaveLength(0);

    // 離職後可以建，狀態是待驗證，證書仍是已驗證
    expect(await endEmploymentFlow(a, emp.id, { endedOn: '2026-11-09' }, t.deps)).toEqual({ status: 'ended' });
    expect(await createEmploymentFlow(bAsPerson, { certificateId: cert.id }, t.deps)).toMatchObject({ status: 'created', employment: { consentRequired: false } });
    const state = await mine(bAsPerson);
    expect(state.certificates[0].state).toBe('verified');
    expect(state.employments).toMatchObject([{ state: 'pending', phase: 'awaiting_review' }]);
    // 換公司只排任職項目，不排證書項目
    const newEmp = (await employmentsOf(b.orgId))[0];
    expect(await openItem('employment', newEmp.id)).toBeTruthy();
    expect(await t.registry(`SELECT 1 FROM registry.review_items WHERE type = 'certificate' AND status = 'open'`)).toHaveLength(0);
    // B 的回應看不到 A 的任職
    expect(state.employments.map((e) => e.id)).toEqual([newEmp.id]);
    // 舊任職已失效，不會回到待驗證（ADR-0017 決議 4）
    expect((await t.registry<{ state: string; ended_on: string }>(`SELECT state, ended_on::text FROM registry.practitioner_employments WHERE id = $1`, [emp.id]))[0]).toMatchObject({ state: 'lapsed', ended_on: '2026-11-09' });
  });

  it('只有管理員與任職本人能結束任職', async () => {
    const a = await t.practiceAccount('a@example.com');
    await register(a);
    const { emp } = await verifyBoth(a);
    // 另一位 staff 成員不能結束別人的任職
    const other = await t.practiceAccount('c@example.com', { name: '丙公司', taxId: '33333333' });
    const staff = await joinOrg(other, a);
    expect(await endEmploymentFlow(staff, emp.id, { endedOn: '2026-11-09' }, t.deps)).toEqual({ status: 'forbidden' });
    expect(await endEmploymentFlow(a, emp.id, { endedOn: '2026-11-09' }, t.deps)).toEqual({ status: 'ended' });
    // 已結束的任職不能再結束
    expect(await endEmploymentFlow(a, emp.id, { endedOn: '2026-11-09' }, t.deps)).toEqual({ status: 'not_verified' });
  });

  it('證書層撞號：兩位使用者登錄同一證號都先待驗證，已驗證的證書只能有一位', async () => {
    const a = await t.practiceAccount('a@example.com');
    const b = await t.practiceAccount('b@example.com', { name: '乙公司', taxId: '22222222' });
    await register(a);
    await register(b);
    const op = await t.operatorAccount();
    const certA = await certOf(a);
    const certB = await certOf(b);
    expect(await recordCredentialCheckFlow(op.run, await openItem('certificate', certA.id), checkForm(), t.deps)).toMatchObject({ status: 'recorded', to: 'verified' });
    expect(await recordCredentialCheckFlow(op.run, await openItem('certificate', certB.id), checkForm(), t.deps)).toMatchObject({ status: 'certificate_taken' });
    expect((await certOf(b)).state).toBe('pending');
  });
});

describe('經紀人員掛第二家與同意書（P0-05 AC3、AC6）', () => {
  async function brokerAtTwoOrgs() {
    const a = await t.practiceAccount('a@example.com', { name: '甲經紀', taxId: '11111111', kinds: ['brokerage'] });
    const b = await t.practiceAccount('b@example.com', { name: '乙經紀', taxId: '22222222', kinds: ['brokerage'] });
    await register(a, { certificateKind: 'real_estate_broker', certWord: '北市經' });
    const first = await verifyBoth(a);
    const bAsPerson = await joinOrg(a, b);
    await agree(bAsPerson);
    const cert = await certOf(a);
    const created = await createEmploymentFlow(bAsPerson, { certificateId: cert.id }, t.deps);
    return { a, b, bAsPerson, cert, first, created };
  }

  it('第二家：提示並要求同意書，仍建待驗證任職，寫提示稽核事件', async () => {
    const { b, created } = await brokerAtTwoOrgs();
    expect(created).toMatchObject({ status: 'created', employment: { consentRequired: true, notice: expect.stringContaining('同意書') } });
    expect((await employmentsOf(b.orgId))[0]).toMatchObject({ state: 'pending', consent_required: true });
    const notices = (await auditOf(b.orgId)).filter((e) => e.action === 'rule.full_time_notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].payload).toMatchObject({ reason: 'second_employment_needs_consent', certificate_number: '112年北市經字第123456號' });
  });

  it('第一次登錄（不是換公司）：別家已有已驗證在職時也提示並要求同意書，仍建待驗證任職（MIL-186）', async () => {
    const a = await t.practiceAccount('a@example.com', { name: '甲經紀', taxId: '11111111', kinds: ['brokerage'] });
    const b = await t.practiceAccount('b@example.com', { name: '乙經紀', taxId: '22222222', kinds: ['brokerage'] });
    const form = { certificateKind: 'real_estate_broker', certWord: '北市經' };
    await register(a, form);
    await verifyBoth(a);

    const result = await register(b, form);
    expect(result).toMatchObject({ status: 'registered', employment: { status: 'created', consentRequired: true, notice: expect.stringContaining('同意書') } });
    expect((await employmentsOf(b.orgId))[0]).toMatchObject({ state: 'pending', consent_required: true });
    const notices = (await auditOf(b.orgId)).filter((e) => e.action === 'rule.full_time_notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].payload).toMatchObject({ reason: 'second_employment_needs_consent', certificate_number: '112年北市經字第123456號' });
    expect(JSON.stringify(result)).not.toMatch(/甲經紀|11111111/);
  });

  it('上傳同意書、營運者核對相符：任職標示「經所屬業者同意」，同意書保留', async () => {
    const { b, bAsPerson } = await brokerAtTwoOrgs();
    const [emp] = await employmentsOf(b.orgId);
    expect(await submitConsentLetterFlow(bAsPerson, emp.id, { files: [pdf('同意書.pdf')] }, t.deps)).toMatchObject({ status: 'submitted' });
    expect((await mine(bAsPerson)).employments[0]).toMatchObject({ consentPhase: 'awaiting_review', consentedByEntity: false });

    const op = await t.operatorAccount();
    const consentItem = await openItem('consent', emp.id);
    expect(await recordCredentialCheckFlow(op.run, consentItem, checkForm({ channel: 'document_review', querySource: '同意書', validUntil: '2027-12-31' }), t.deps)).toMatchObject({
      status: 'recorded',
      result: 'match',
    });
    expect((await mine(bAsPerson)).employments[0]).toMatchObject({ consentPhase: 'verified', consentedByEntity: true, consentValidUntil: '2027-12-31' });
    // 同意書不因相符而刪除（ADR-0017 補充）
    const consent = await t.registry<{ state: string }>(`SELECT state FROM vault.credential_evidence WHERE subject_type = 'employment_consent'`);
    expect(consent).toEqual([{ state: 'stored' }]);

    // 任職核對相符時沒有同意書警示
    const result = await recordCredentialCheckFlow(op.run, await openItem('employment', emp.id), checkForm({ validUntil: '' }), t.deps);
    expect(result).toMatchObject({ status: 'recorded', to: 'verified', warnings: [] });
    expect((await inOrg(bAsPerson, listOrgEmployments)).find((e) => e.id === emp.id)).toMatchObject({ consentedByEntity: true, state: 'verified' });
  });

  it('同意書還沒核對就核對任職相符：不擋，但回傳警示並寫提示稽核事件', async () => {
    const { b } = await brokerAtTwoOrgs();
    const [emp] = await employmentsOf(b.orgId);
    const op = await t.operatorAccount();
    const result = await recordCredentialCheckFlow(op.run, await openItem('employment', emp.id), checkForm({ validUntil: '' }), t.deps);
    expect(result).toMatchObject({ status: 'recorded', to: 'verified', warnings: ['consent_missing'] });
  });

  it('同意書不符：任職維持原狀，執業人員看到補件原因並收到信', async () => {
    const { b, bAsPerson } = await brokerAtTwoOrgs();
    const [emp] = await employmentsOf(b.orgId);
    await submitConsentLetterFlow(bAsPerson, emp.id, { files: [pdf('同意書.pdf')] }, t.deps);
    const op = await t.operatorAccount();
    const result = await recordCredentialCheckFlow(op.run, await openItem('consent', emp.id), checkForm({ channel: 'document_review', result: 'mismatch', note: '同意書缺所屬業者用印' }), t.deps);
    expect(result).toMatchObject({ status: 'recorded', result: 'mismatch' });
    expect((await mine(bAsPerson)).employments[0]).toMatchObject({ consentPhase: 'needs_resubmission', consentNote: '同意書缺所屬業者用印', consentedByEntity: false });
    expect(t.mailer.sent.at(-1)!.text).toContain('同意書缺所屬業者用印');
    // 不符的同意書保留，補件時是新的項目
    expect(await submitConsentLetterFlow(bAsPerson, emp.id, { files: [pdf('同意書-用印.pdf')] }, t.deps)).toMatchObject({ status: 'submitted' });
  });

  it('不需要同意書的任職不能送同意書', async () => {
    const a = await t.practiceAccount('a@example.com');
    await register(a);
    const [emp] = await employmentsOf(a.orgId);
    expect(await submitConsentLetterFlow(a, emp.id, { files: [pdf()] }, t.deps)).toEqual({ status: 'not_required' });
    expect(await t.registry(`SELECT 1 FROM vault.credential_evidence WHERE subject_type = 'employment_consent'`)).toHaveLength(0);
  });
});

const inOrg = <R>(a: Account, fn: (tx: OrgTx) => Promise<R>) => withTx({ kind: 'org', orgId: a.orgId, partyId: a.partyId }, (tx) => fn(tx));

describe('給其他線的查詢', () => {
  it('標章：證書層已驗證才有，文字固定為「證書資料已核對」加核對日，不含禁用字樣（P0-04 AC6）', async () => {
    const a = await t.practiceAccount('a@example.com');
    const b = await t.practiceAccount('b@example.com', { name: '乙公司', taxId: '22222222' });
    await register(a);
    const query = () => withTx({ kind: 'org', orgId: b.orgId, partyId: b.partyId }, (tx) => getCertificateBadges(tx, [a.partyId]));
    expect(await query()).toEqual([]);
    await verifyBoth(a);
    const [badge] = await query();
    expect(badge).toMatchObject({ partyId: a.partyId, certificateKind: 'rental_housing_manager', badge: { text: '證書資料已核對', display: expect.stringMatching(/^證書資料已核對 \d{4}-\d{2}-\d{2}$/) } });
    expect(JSON.stringify(badge)).not.toMatch(/保證合法|認證|擔保|123456/);
  });

  it('可簽章判定事實：三層狀態、效期、任職期間、三層最新核對紀錄 ID、遮罩前證號；只給該執業主體自己的組織', async () => {
    const a = await t.practiceAccount('a@example.com');
    const b = await t.practiceAccount('b@example.com', { name: '乙公司', taxId: '22222222' });
    await register(a);
    const { cert, emp } = await verifyBoth(a);
    const [entity] = await t.registry<{ id: string }>('SELECT id FROM registry.practice_entities WHERE org_id = $1', [a.orgId]);
    const asA = await withTx({ kind: 'org', orgId: a.orgId, partyId: a.partyId }, (tx) => getSigningFacts(tx, entity.id, [a.partyId]));
    expect(asA.practitioners).toHaveLength(1);
    const checks = await t.registry<{ id: string; subject_type: string }>('SELECT id, subject_type FROM registry.credential_checks');
    expect(asA.practitioners[0]).toMatchObject({
      partyId: a.partyId,
      employmentId: emp.id,
      practitionerId: cert.id,
      certificateKind: 'rental_housing_manager',
      certificateNo: { year: '112', word: '內授營', serial: '123456' },
      practitionerState: 'verified',
      validUntil: '2028-03-01',
      practitionerLastCheckId: checks.find((c) => c.subject_type === 'practitioner')!.id,
      employmentState: 'verified',
      employmentEndedOn: null,
      employmentLastCheckId: checks.find((c) => c.subject_type === 'employment')!.id,
    });
    expect(asA.practitioners[0].employmentStartedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(asA.licenses).toMatchObject([{ kind: 'management', state: 'pending' }]);

    // 別的組織拿不到，也無法與「不存在」區分
    const asB = await withTx({ kind: 'org', orgId: b.orgId, partyId: b.partyId }, (tx) => getSigningFacts(tx, entity.id, [a.partyId]));
    const missing = await withTx({ kind: 'org', orgId: b.orgId, partyId: b.partyId }, (tx) => getSigningFacts(tx, newUlid(), [a.partyId]));
    expect(asB).toEqual({ licenses: [], practitioners: [] });
    expect(asB).toEqual(missing);
    // 營運者可以查
    const op = await t.operatorAccount();
    expect((await op.run('desk:facts', (tx) => getSigningFacts(tx, entity.id, [a.partyId]))).practitioners).toHaveLength(1);
  });

  it('任職清單只列自己組織的任職', async () => {
    const a = await t.practiceAccount('a@example.com');
    const b = await t.practiceAccount('b@example.com', { name: '乙公司', taxId: '22222222' });
    await register(a);
    await register(b, { certSerial: '777777' });
    const list = await inOrg(a, listOrgEmployments);
    expect(list).toMatchObject([{ certificateKind: 'rental_housing_manager', number: { serial: '123456' }, state: 'pending', isSelf: true }]);
  });
});

describe('權限', () => {
  it('審核台函式只有平台營運者能呼叫：組織脈絡呼叫被資料庫拒絕', async () => {
    const a = await t.practiceAccount('a@example.com');
    await register(a);
    await expect(withTx({ kind: 'org', orgId: a.orgId, partyId: a.partyId }, (tx) => tx.query('SELECT * FROM registry.review_queue()'))).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTx({ kind: 'org', orgId: a.orgId, partyId: a.partyId }, (tx) =>
        tx.query(`SELECT registry.record_practitioner_check($1, NULL, $2, 'resim_manual', 'x', '{}'::jsonb, 'match', '{}', '', 'pending', 'verified', '2028-01-01', NULL, 'c', 1)`, [newUlid(), newUlid()]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('app_rw 不能直接讀寫新表', async () => {
    const a = await t.practiceAccount('a@example.com');
    await expect(withTx({ kind: 'org', orgId: a.orgId, partyId: a.partyId }, (tx) => tx.query('SELECT * FROM registry.practitioners'))).rejects.toMatchObject({ code: '42501' });
    await expect(withTx({ kind: 'org', orgId: a.orgId, partyId: a.partyId }, (tx) => tx.query('SELECT * FROM registry.practitioner_employments'))).rejects.toMatchObject({ code: '42501' });
  });
});
