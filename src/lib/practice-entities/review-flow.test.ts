import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_ORG_ID } from '../auth/config';
import { withTx } from '../pg/database';
import { listQueue, getMyRegistration, getReviewDetail, lookupPracticeEntities, openEvidenceFlow, recordCheckFlow, resolveClaimFlow, submitLicenseFlow } from './index';
import { pdf, setupPracticeKit, type Account, type PracticeKit } from './test-kit';

// MIL-109：執業主體送件、審核台核對、證據檔、認領歸屬、批次查詢。真實 migration、app_rw 連線、本機 FileStore。

let t: PracticeKit;
beforeAll(async () => {
  t = await setupPracticeKit();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const NOW = new Date('2026-11-09T12:00:00Z');
const matchForm = (over: Record<string, unknown> = {}) => ({
  channel: 'gcis_manual',
  querySource: '商工登記公示資料查詢',
  result: 'match',
  note: '',
  businessItemCodes: ['H706011', 'H703100'],
  registrationStatus: '核准設立',
  ...over,
});

const mine = (a: Account) => withTx({ kind: 'org', orgId: a.orgId, partyId: a.partyId }, (tx) => getMyRegistration(tx));
const submit = (a: Account, over: Record<string, unknown> = {}) =>
  submitLicenseFlow(a, { kind: 'management', permitNo: '北市租管字第 123 號', files: [pdf()], ...over }, t.deps);

async function openItemId(a: Account, kind = 'management'): Promise<string> {
  const rows = await t.registry<{ id: string }>(
    `SELECT r.id FROM registry.review_items r JOIN registry.practice_licenses l ON l.id = r.subject_id
      WHERE r.type = 'license' AND r.status = 'open' AND l.kind = $1 AND l.entity_id IN (SELECT id FROM registry.practice_entities WHERE org_id = $2)`,
    [kind, a.orgId],
  );
  return rows[0].id;
}

describe('執業主體送件', () => {
  it('登錄後業別是待驗證、尚未送件；送件後進入待核對，證字號、證據檔中繼資料與檔案都到位', async () => {
    const a = await t.practiceAccount('a@example.com');
    expect((await mine(a))?.licenses).toMatchObject([{ kind: 'management', state: 'pending', phase: 'not_submitted', permitNo: null }]);

    expect(await submit(a)).toMatchObject({ status: 'submitted', kind: 'management', from: 'pending' });

    const reg = await mine(a);
    expect(reg?.licenses[0]).toMatchObject({ state: 'pending', phase: 'awaiting_review', permitNo: '北市租管字第 123 號' });
    const evidence = await t.registry<{ object_key: string; state: string; org_id: string; sha256: string }>('SELECT object_key, state, org_id, sha256 FROM vault.credential_evidence');
    expect(evidence).toHaveLength(1);
    expect(evidence[0].org_id).toBe(a.orgId);
    expect(evidence[0].object_key).toMatch(new RegExp(`^org/${a.orgId}/vault/credential-evidence/[0-9A-Z]{26}\\.pdf$`));
    expect(await t.store.exists(evidence[0].object_key as never)).toBe(true);
  });

  it('送件寫稽核事件 practice_entity.submit 與 vault.upload，進送件組織自己的鏈，事件不含證字號與檔名', async () => {
    const a = await t.practiceAccount('a@example.com');
    await submit(a);
    const events = await withTx({ kind: 'org', orgId: a.orgId }, async (tx) =>
      (await tx.query<{ action: string; payload: Record<string, unknown> }>('SELECT action, payload FROM audit.events ORDER BY seq')).rows,
    );
    expect(events.map((e) => e.action)).toEqual(['org.create', 'member.grant', 'practice_entity.register', 'vault.upload', 'practice_entity.submit']);
    expect(JSON.stringify(events)).not.toContain('北市租管字第');
    expect(JSON.stringify(events)).not.toContain('許可函');
  });

  it('欄位錯誤不寫任何東西：沒有證據檔、字號空白', async () => {
    const a = await t.practiceAccount('a@example.com');
    expect(await submit(a, { files: [] })).toMatchObject({ status: 'invalid', field: 'files' });
    expect(await submit(a, { permitNo: ' ' })).toMatchObject({ status: 'invalid', field: 'permitNo' });
    expect(await t.registry('SELECT 1 FROM vault.credential_evidence')).toHaveLength(0);
    expect((await mine(a))?.licenses[0].phase).toBe('not_submitted');
  });

  it('新增另一個業別：建 pending 業別與待核對項目', async () => {
    const a = await t.practiceAccount('a@example.com');
    expect(await submit(a, { kind: 'brokerage', permitNo: '北市經紀字第 9 號' })).toMatchObject({ status: 'submitted', from: null });
    expect((await mine(a))?.licenses.map((l) => [l.kind, l.state, l.phase])).toEqual([
      ['brokerage', 'pending', 'awaiting_review'],
      ['management', 'pending', 'not_submitted'],
    ]);
  });

  it('商號不能登錄代管與包租（P0-03 AC3），檔案不留在 FileStore', async () => {
    const a = await t.practiceAccount('a@example.com', { entityType: 'firm', kinds: ['brokerage'] });
    expect(await submit(a, { kind: 'management' })).toMatchObject({ status: 'company_required' });
    expect(await t.registry('SELECT 1 FROM vault.credential_evidence')).toHaveLength(0);
    expect(t.storeFiles()).toEqual([]);
  });

  it('屋主組織與唯讀成員不能送件', async () => {
    const a = await t.practiceAccount('a@example.com');
    expect(await submitLicenseFlow({ ...a, orgKind: 'owner' }, { kind: 'management', permitNo: 'x', files: [pdf()] }, t.deps)).toEqual({ status: 'forbidden' });
    expect(await submitLicenseFlow({ ...a, role: 'viewer' }, { kind: 'management', permitNo: 'x', files: [pdf()] }, t.deps)).toEqual({ status: 'forbidden' });
  });

  it('待核對時再送一次：同一個業別只有一個待核對項目，等待時間重算', async () => {
    const a = await t.practiceAccount('a@example.com');
    await submit(a);
    await submit(a, { permitNo: '更正後的字號' });
    const items = await t.registry('SELECT 1 FROM registry.review_items WHERE type = \'license\' AND status = \'open\'');
    expect(items).toHaveLength(1);
    expect((await mine(a))?.licenses[0].permitNo).toBe('更正後的字號');
  });
});

describe('審核台佇列與權限', () => {
  it('尚未送件的業別不在佇列；送件後出現，帶業別、證字號與等待時間；老的排前面', async () => {
    const a = await t.practiceAccount('a@example.com');
    const b = await t.practiceAccount('b@example.com', { name: '乙公司', taxId: '22222222' });
    const op = await t.operatorAccount();
    expect(await op.run('desk:queue', (tx) => listQueue(tx, 'open', NOW))).toEqual([]);

    await submit(b);
    await submit(a);
    const queue = await op.run('desk:queue', (tx) => listQueue(tx, 'open', new Date(Date.now() + 3 * 3600_000)));
    expect(queue.map((q) => q.summary.entityName)).toEqual(['乙公司', '安心代管有限公司']);
    expect(queue[0]).toMatchObject({ type: 'license', status: 'open', summary: { kind: 'management', permitNo: '北市租管字第 123 號', taxId: '22222222' } });
    expect(queue[0].waitingMs).toBeGreaterThan(3 * 3600_000 - 60_000);
  });

  it('app_rw 直接查表被拒；組織脈絡呼叫審核台函式被拒；不是營運者的帳號即使設了 operator 脈絡也被拒', async () => {
    const a = await t.practiceAccount('a@example.com');
    for (const table of ['registry.credential_checks', 'vault.credential_evidence']) {
      await expect(withTx({ kind: 'org', orgId: a.orgId }, (tx) => tx.query(`SELECT * FROM ${table}`))).rejects.toThrow(/permission denied/);
      await expect(withTx({ kind: 'org', orgId: a.orgId }, (tx) => tx.query(`DELETE FROM ${table}`))).rejects.toThrow(/permission denied/);
    }
    for (const sql of ['SELECT * FROM registry.review_queue()', "SELECT registry.review_item_detail('x')", 'SELECT * FROM vault.pending_file_removals()']) {
      await expect(withTx({ kind: 'org', orgId: a.orgId }, (tx) => tx.query(sql))).rejects.toThrow(/只有平台營運者/);
    }
    // 一般成員的帳號 ID 放進 operator 脈絡，仍不是平台組織成員
    await expect(
      withTx({ kind: 'operator', operatorId: a.userId, orgId: PLATFORM_ORG_ID, ticketId: 'desk:queue' }, (tx) => tx.query('SELECT * FROM registry.review_queue()')),
    ).rejects.toThrow(/只有平台營運者/);
  });
});

describe('核對：相符', () => {
  it('營業項目含 H706011 且登記狀態核准設立：業別轉已驗證，記核對者、時間與結果，項目結案', async () => {
    const a = await t.practiceAccount('a@example.com');
    const op = await t.operatorAccount();
    await submit(a);
    const itemId = await openItemId(a);

    const result = await recordCheckFlow(op.run, itemId, matchForm(), t.deps);
    expect(result).toMatchObject({ status: 'recorded', from: 'pending', to: 'verified', result: 'match', supplement: null });

    expect((await mine(a))?.licenses[0]).toMatchObject({ state: 'verified', phase: 'verified', lastResult: 'match' });
    const checks = await t.registry<Record<string, unknown>>('SELECT * FROM registry.credential_checks');
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      subject_type: 'license', channel: 'gcis_manual', query_source: '商工登記公示資料查詢', result: 'match', checked_by: op.userId,
    });
    expect(checks[0].observed).toMatchObject({ business_item_codes: ['H706011', 'H703100'], registration_status: '核准設立' });
    expect(checks[0].checked_at).toBeInstanceOf(Date);
    const item = (await t.registry<{ status: string; resolution: string; resolved_by: string }>('SELECT status, resolution, resolved_by FROM registry.review_items WHERE id = $1', [itemId]))[0];
    expect(item).toEqual({ status: 'resolved', resolution: 'match', resolved_by: op.userId });
    const entity = (await t.registry<{ business_item_codes: string[]; registration_status: string }>('SELECT business_item_codes, registration_status FROM registry.practice_entities'))[0];
    expect(entity).toEqual({ business_item_codes: ['H706011', 'H703100'], registration_status: '核准設立' });
  });

  it('核對紀錄與稽核事件同交易：事件在平台組織的鏈，行為者是營運者，紀錄存事件位置', async () => {
    const a = await t.practiceAccount('a@example.com');
    const op = await t.operatorAccount();
    await submit(a);
    await recordCheckFlow(op.run, await openItemId(a), matchForm(), t.deps);

    const check = (await t.registry<{ id: string; audit_chain_id: string; audit_seq: string }>('SELECT id, audit_chain_id, audit_seq FROM registry.credential_checks'))[0];
    expect(check.audit_chain_id).toBe(PLATFORM_ORG_ID);
    const events = await op.run('desk:audit', async (tx) =>
      (await tx.query<{ seq: string; action: string; actor_type: string; actor_id: string; payload: Record<string, unknown> }>(
        'SELECT seq, action, actor_type, actor_id, payload FROM audit.events ORDER BY seq',
      )).rows,
    );
    const verify = events.find((e) => e.action === 'practice_entity.verify')!;
    expect(String(verify.seq)).toBe(String(check.audit_seq));
    expect(verify).toMatchObject({ actor_type: 'operator', actor_id: op.userId });
    expect(verify.payload).toMatchObject({ check_id: check.id, result: 'match', from: 'pending', to: 'verified' });
    // 證據檔刪除與開啟的事件也在這條鏈
    expect(events.map((e) => e.action)).toContain('vault.delete');
    // 沒有寫到執業主體組織的鏈
    const orgEvents = await withTx({ kind: 'org', orgId: a.orgId }, async (tx) => (await tx.query<{ action: string }>('SELECT action FROM audit.events')).rows.map((r) => r.action));
    expect(orgEvents).not.toContain('practice_entity.verify');
  });

  it('只有 H703100：被拒並列出缺少的項目 H706011，什麼都沒寫入，證據檔還在', async () => {
    const a = await t.practiceAccount('a@example.com');
    const op = await t.operatorAccount();
    await submit(a);
    const result = await recordCheckFlow(op.run, await openItemId(a), matchForm({ businessItemCodes: ['H703100'] }), t.deps);

    expect(result).toMatchObject({ status: 'ineligible', reasons: [{ code: 'missing_business_item', kind: 'management', missing: 'H706011' }] });
    expect(await t.registry('SELECT 1 FROM registry.credential_checks')).toHaveLength(0);
    expect((await mine(a))?.licenses[0].state).toBe('pending');
    expect((await t.registry<{ state: string }>('SELECT state FROM vault.credential_evidence'))[0].state).toBe('stored');
    expect(t.storeFiles()).toHaveLength(1);
  });

  it('登記狀態不是核准設立時不能判定相符', async () => {
    const a = await t.practiceAccount('a@example.com');
    const op = await t.operatorAccount();
    await submit(a);
    expect(await recordCheckFlow(op.run, await openItemId(a), matchForm({ registrationStatus: '解散' }), t.deps)).toMatchObject({
      status: 'registration_not_approved',
    });
    expect((await mine(a))?.licenses[0].state).toBe('pending');
  });

  it('相符後刪除證據檔：中繼資料標記刪除與原因，FileStore 的檔案沒了，刪除方式寫稽核事件', async () => {
    const a = await t.practiceAccount('a@example.com');
    const op = await t.operatorAccount();
    await submit(a);
    const key = (await t.registry<{ object_key: string }>('SELECT object_key FROM vault.credential_evidence'))[0].object_key;
    await recordCheckFlow(op.run, await openItemId(a), matchForm(), t.deps);

    const row = (await t.registry<Record<string, unknown>>('SELECT * FROM vault.credential_evidence'))[0];
    expect(row).toMatchObject({ state: 'deleted', delete_reason: 'matched', delete_method: 'file_store_delete' });
    expect(row.deleted_at).toBeInstanceOf(Date);
    expect(row.file_removed_at).toBeInstanceOf(Date);
    expect(await t.store.exists(key as never)).toBe(false);

    const del = await op.run('desk:audit', async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit.events WHERE action = 'vault.delete'")).rows);
    expect(del).toHaveLength(1);
    expect(del[0].payload).toMatchObject({ reason: 'matched', method: 'file_store_delete' });
    // 核對紀錄記得當時參考的證據檔 ID
    const check = (await t.registry<{ evidence_version_ids: string[] }>('SELECT evidence_version_ids FROM registry.credential_checks'))[0];
    expect(check.evidence_version_ids).toEqual([row.id]);
  });

  it('刪檔失敗時：核對結果不受影響，資料庫標記還在，pending_file_removals 找得到，重試後確認', async () => {
    const a = await t.practiceAccount('a@example.com');
    const op = await t.operatorAccount();
    await submit(a);
    const failing = { ...t.store, delete: async () => { throw new Error('GCS 暫時失敗'); } };
    const result = await recordCheckFlow(op.run, await openItemId(a), matchForm(), { ...t.deps, store: failing });
    expect(result).toMatchObject({ status: 'recorded', to: 'verified' });

    const pending = await op.run('desk:retry', async (tx) => (await tx.query<{ id: string }>('SELECT * FROM vault.pending_file_removals()')).rows);
    expect(pending).toHaveLength(1);
    const { pendingFileRemovals } = await import('./evidence');
    const { removeDeletedFiles, confirmFilesRemoved } = await import('./evidence');
    const items = await op.run('desk:retry', (tx) => pendingFileRemovals(tx));
    const removed = await removeDeletedFiles(t.store, items);
    await op.run('desk:retry', (tx) => confirmFilesRemoved(tx, removed));
    expect(await op.run('desk:retry', (tx) => pendingFileRemovals(tx))).toEqual([]);
    expect(t.storeFiles()).toEqual([]);
  });
});

describe('核對：不符', () => {
  it('維持待驗證，項目結案，執業主體在頁面看到補件原因並收到信，證據檔保留', async () => {
    const a = await t.practiceAccount('a@example.com');
    const op = await t.operatorAccount();
    await submit(a);
    const itemId = await openItemId(a);

    const result = await recordCheckFlow(op.run, itemId, matchForm({ result: 'mismatch', note: '證字號與商工登記的公司名稱不符，請重新上傳許可函' }), t.deps);
    expect(result).toMatchObject({ status: 'recorded', from: 'pending', to: 'pending', result: 'mismatch' });

    expect((await mine(a))?.licenses[0]).toMatchObject({
      state: 'pending', phase: 'needs_resubmission', lastResult: 'mismatch', lastNote: '證字號與商工登記的公司名稱不符，請重新上傳許可函',
    });
    const supplementMail = t.mailer.sent.find((m) => m.kind === 'registry.supplement_requested')!;
    expect(supplementMail.to).toBe('a@example.com');
    expect(supplementMail.text).toContain('證字號與商工登記的公司名稱不符');
    expect(supplementMail.text).not.toContain('12345678');
    expect((await t.registry<{ state: string }>('SELECT state FROM vault.credential_evidence'))[0].state).toBe('stored');
    expect((await t.registry<{ status: string; resolution: string }>('SELECT status, resolution FROM registry.review_items WHERE id = $1', [itemId]))[0]).toEqual({
      status: 'resolved', resolution: 'mismatch',
    });
  });

  it('補件後重新排進佇列，再核對相符就轉已驗證，兩次核對紀錄都留著', async () => {
    const a = await t.practiceAccount('a@example.com');
    const op = await t.operatorAccount();
    await submit(a);
    await recordCheckFlow(op.run, await openItemId(a), matchForm({ result: 'not_found', note: '查無此證字號' }), t.deps);
    expect(await submit(a, { permitNo: '更正的字號' })).toMatchObject({ status: 'submitted', from: 'pending' });
    expect((await mine(a))?.licenses[0].phase).toBe('awaiting_review');

    expect(await recordCheckFlow(op.run, await openItemId(a), matchForm(), t.deps)).toMatchObject({ to: 'verified' });
    const checks = await t.registry<{ result: string }>('SELECT result FROM registry.credential_checks ORDER BY checked_at, id');
    expect(checks.map((c) => c.result)).toEqual(['not_found', 'match']);
  });

  it('不是相符時沒寫判定理由被擋，什麼都沒寫入', async () => {
    const a = await t.practiceAccount('a@example.com');
    const op = await t.operatorAccount();
    await submit(a);
    expect(await recordCheckFlow(op.run, await openItemId(a), matchForm({ result: 'mismatch', note: '' }), t.deps)).toMatchObject({ status: 'invalid', field: 'note' });
    expect(await t.registry('SELECT 1 FROM registry.credential_checks')).toHaveLength(0);
  });

  it('同一個項目核對兩次：第二次回已結案', async () => {
    const a = await t.practiceAccount('a@example.com');
    const op = await t.operatorAccount();
    await submit(a);
    const itemId = await openItemId(a);
    await recordCheckFlow(op.run, itemId, matchForm(), t.deps);
    expect(await recordCheckFlow(op.run, itemId, matchForm(), t.deps)).toEqual({ status: 'already_resolved' });
  });

  it('找不到項目、項目類型不對', async () => {
    const op = await t.operatorAccount();
    expect(await recordCheckFlow(op.run, '01ARZ3NDEKTSV4RRFFQ69G5FAV', matchForm(), t.deps)).toEqual({ status: 'not_found' });
  });
});

describe('登記狀態不是核准設立：全部業別轉已失效', () => {
  it('另一個業別核對時發現登記狀態不是核准設立：已驗證的業別各寫一筆 revoked 紀錄並轉 lapsed', async () => {
    const a = await t.practiceAccount('a@example.com', { kinds: ['management', 'master_lease'] });
    const op = await t.operatorAccount();
    await submit(a, { kind: 'management' });
    await recordCheckFlow(op.run, await openItemId(a, 'management'), matchForm(), t.deps);
    await submit(a, { kind: 'master_lease', permitNo: '包租字第 1 號' });

    const result = await recordCheckFlow(
      op.run,
      await openItemId(a, 'master_lease'),
      matchForm({ result: 'revoked', note: '商工登記已廢止', registrationStatus: '廢止', businessItemCodes: ['H706021'] }),
      t.deps,
    );
    expect(result).toMatchObject({ status: 'recorded', to: 'pending', lapsedLicenseIds: [expect.any(String)] });

    const states = await t.registry<{ kind: string; state: string }>('SELECT kind, state FROM registry.practice_licenses ORDER BY kind');
    expect(states).toEqual([{ kind: 'management', state: 'lapsed' }, { kind: 'master_lease', state: 'pending' }]);
    const checks = await t.registry<{ result: string; note: string }>('SELECT result, note FROM registry.credential_checks ORDER BY checked_at, id');
    expect(checks.map((c) => c.result)).toEqual(['match', 'revoked', 'revoked']);
    // 失效的業別在執業主體頁面顯示原因
    expect((await mine(a))?.licenses.find((l) => l.kind === 'management')).toMatchObject({ state: 'lapsed', phase: 'lapsed', lastNote: expect.stringContaining('登記狀態') });
  });
});

describe('核對紀錄只增不改（資料庫層）', () => {
  it('UPDATE、DELETE、TRUNCATE 都被觸發器擋下，擁有者也一樣', async () => {
    const a = await t.practiceAccount('a@example.com');
    const op = await t.operatorAccount();
    await submit(a);
    await recordCheckFlow(op.run, await openItemId(a), matchForm(), t.deps);
    for (const sql of ["UPDATE registry.credential_checks SET note = '改'", 'DELETE FROM registry.credential_checks', 'TRUNCATE registry.credential_checks']) {
      await expect(t.kit.asOwner((db) => db.query(sql))).rejects.toThrow(/只增不改/);
    }
    expect(await t.registry('SELECT 1 FROM registry.credential_checks')).toHaveLength(1);
  });
});

describe('證據檔', () => {
  it('營運者開啟：同交易寫 vault.read，回傳原始位元組；相符刪除後再開回 not_found', async () => {
    const a = await t.practiceAccount('a@example.com');
    const op = await t.operatorAccount();
    await submit(a);
    const detail = await op.run('desk:detail', (tx) => getReviewDetail(tx, '')).catch(() => null);
    expect(detail).toBeNull();
    const evidenceId = (await t.registry<{ id: string }>('SELECT id FROM vault.credential_evidence'))[0].id;

    const opened = await openEvidenceFlow(op.run, evidenceId, t.deps);
    expect(opened).toMatchObject({ status: 'ok', contentType: 'application/pdf', fileName: '許可函.pdf' });
    if (opened.status === 'ok') expect(new TextDecoder().decode(opened.bytes)).toContain('%PDF');
    const reads = await op.run('desk:audit', async (tx) => (await tx.query<{ actor_type: string; object_id: string }>("SELECT actor_type, object_id FROM audit.events WHERE action = 'vault.read'")).rows);
    expect(reads).toEqual([{ actor_type: 'operator', object_id: evidenceId }]);

    await recordCheckFlow(op.run, await openItemId(a), matchForm(), t.deps);
    expect(await openEvidenceFlow(op.run, evidenceId, t.deps)).toEqual({ status: 'not_found' });
    // 找不到的不寫 vault.read
    const after = await op.run('desk:audit', async (tx) => (await tx.query("SELECT 1 FROM audit.events WHERE action = 'vault.read'")).rows);
    expect(after).toHaveLength(1);
  });

  it('檔案不見或內容被改：回 file_missing、file_corrupted，不把壞檔交出去', async () => {
    const a = await t.practiceAccount('a@example.com');
    const op = await t.operatorAccount();
    await submit(a);
    const row = (await t.registry<{ id: string; object_key: string }>('SELECT id, object_key FROM vault.credential_evidence'))[0];
    await t.store.write(row.object_key as never, new TextEncoder().encode('%PDF-被換掉'), { contentType: 'application/pdf' });
    expect(await openEvidenceFlow(op.run, row.id, t.deps)).toEqual({ status: 'file_corrupted' });
    await t.store.delete(row.object_key as never);
    expect(await openEvidenceFlow(op.run, row.id, t.deps)).toEqual({ status: 'file_missing' });
  });

  it('組織脈絡不能開啟證據檔、不能把檔案掛在別的組織的業別上', async () => {
    const a = await t.practiceAccount('a@example.com');
    const b = await t.practiceAccount('b@example.com', { taxId: '22222222', name: '乙公司' });
    await submit(a);
    const evidenceId = (await t.registry<{ id: string }>('SELECT id FROM vault.credential_evidence'))[0].id;
    await expect(withTx({ kind: 'org', orgId: a.orgId }, (tx) => tx.query('SELECT * FROM vault.open_credential_evidence($1)', [evidenceId]))).rejects.toThrow(/只有平台營運者/);

    const licenseOfA = (await t.registry<{ id: string }>('SELECT l.id FROM registry.practice_licenses l JOIN registry.practice_entities e ON e.id = l.entity_id WHERE e.org_id = $1', [a.orgId]))[0].id;
    await expect(
      withTx({ kind: 'org', orgId: b.orgId }, (tx) =>
        tx.query(`SELECT vault.register_credential_evidence('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'license', $1, 'management', $2, repeat('a', 64), 1, 'application/pdf', 'x.pdf', 'u')`, [
          licenseOfA, `org/${b.orgId}/vault/credential-evidence/01ARZ3NDEKTSV4RRFFQ69G5FAV.pdf`,
        ]),
      ),
    ).rejects.toThrow(/不能對該對象上傳/);
  });

  it('資料庫保證 key 前綴：key 不在該組織的 vault 區就寫不進去', async () => {
    const a = await t.practiceAccount('a@example.com');
    await submit(a);
    const licenseId = (await t.registry<{ id: string }>('SELECT id FROM registry.practice_licenses'))[0].id;
    await expect(
      withTx({ kind: 'org', orgId: a.orgId }, (tx) =>
        tx.query(`SELECT vault.register_credential_evidence('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'license', $1, 'management', 'org/別人/sign-tasks/x.pdf', repeat('a', 64), 1, 'application/pdf', 'x.pdf', 'u')`, [licenseId]),
      ),
    ).rejects.toThrow(/credential_evidence_key_prefix|violates check/);
  });
});

describe('第二個組織認領同一統編', () => {
  async function claimSetup() {
    const a = await t.practiceAccount('a@example.com', { name: '同名公司', kinds: ['management'] });
    const b = await t.practiceAccount('b@example.com', { name: '同名公司', kinds: ['management'] });
    const op = await t.operatorAccount();
    return { a, b, op };
  }

  it('回應不區分登錄者與認領方：兩邊看到的登錄進度形狀與值完全相同', async () => {
    const { a, b } = await claimSetup();
    expect(await mine(b)).toEqual(await mine(a));
    await submit(a);
    await submit(b, { permitNo: '北市租管字第 123 號' });
    // 兩次送件的時間不同，其餘欄位逐一相同
    const noTime = (r: Awaited<ReturnType<typeof mine>>) => ({ ...r, licenses: r?.licenses.map((l) => ({ ...l, submittedAt: l.submittedAt ? 'T' : null })) });
    expect(noTime(await mine(b))).toEqual(noTime(await mine(a)));
    // 認領方送件的證據檔掛在認領項目上，不是業別
    expect((await t.registry<{ subject_type: string }>('SELECT subject_type FROM vault.credential_evidence WHERE org_id = $1', [b.orgId]))[0].subject_type).toBe('claim');
  });

  it('審核台列出認領項目，詳情同時顯示登錄者與認領方的組織名稱與認領方送的字號', async () => {
    const { a, b, op } = await claimSetup();
    await submit(b, { permitNo: '認領方的字號' });
    const queue = await op.run('desk:queue', (tx) => listQueue(tx, 'open', NOW));
    const claim = queue.find((q) => q.type === 'entity_claim')!;
    expect(claim.summary).toMatchObject({ taxId: '12345678', kinds: ['management'] });

    const detail = await op.run('desk:detail', (tx) => getReviewDetail(tx, claim.id));
    expect(detail?.entity?.orgId).toBe(a.orgId);
    expect(detail?.claim).toMatchObject({ claimantOrgId: b.orgId, submissions: { management: { permitNo: '認領方的字號' } } });
    expect(detail?.evidence).toHaveLength(1);
  });

  it('判定維持原登錄者：認領項目結案，認領方看到補件原因、收到信，認領方的證據檔刪除，登錄者不受影響', async () => {
    const { a, b, op } = await claimSetup();
    await submit(b);
    const claimId = (await t.registry<{ id: string }>("SELECT id FROM registry.review_items WHERE type = 'entity_claim'"))[0].id;
    const result = await resolveClaimFlow(op.run, claimId, { decision: 'keep_registrant', note: '商工登記的負責人與原登錄者相符，請提供授權文件' }, t.deps);
    expect(result).toMatchObject({ status: 'resolved', decision: 'keep_registrant', claimantOrgId: b.orgId });

    expect((await mine(b))?.licenses[0]).toMatchObject({ phase: 'needs_resubmission', lastNote: '商工登記的負責人與原登錄者相符，請提供授權文件' });
    expect(t.mailer.sent.at(-1)).toMatchObject({ to: 'b@example.com', kind: 'registry.supplement_requested' });
    expect((await t.registry<{ org_id: string }>('SELECT org_id FROM registry.practice_entities'))[0].org_id).toBe(a.orgId);
    expect((await t.registry<{ state: string; delete_reason: string }>('SELECT state, delete_reason FROM vault.credential_evidence'))[0]).toEqual({ state: 'deleted', delete_reason: 'withdrawn' });

    // 認領方補件重送：產生一筆新的認領項目
    expect(await submit(b, { permitNo: '補上授權文件' })).toMatchObject({ status: 'submitted' });
    expect((await t.registry('SELECT 1 FROM registry.review_items WHERE type = \'entity_claim\' AND status = \'open\''))).toHaveLength(1);
    expect((await mine(b))?.licenses[0].phase).toBe('awaiting_review');
  });

  it('判定歸屬給認領方：執業主體改歸認領方，原登錄者看不到登錄，業別字號與證據檔改為認領方的，重新排待核對項目', async () => {
    const { a, b, op } = await claimSetup();
    await submit(a, { permitNo: '原登錄者的字號' });
    await submit(b, { permitNo: '認領方的字號' });
    const claimId = (await t.registry<{ id: string }>("SELECT id FROM registry.review_items WHERE type = 'entity_claim'"))[0].id;

    const result = await resolveClaimFlow(op.run, claimId, { decision: 'to_claimant', note: '認領方提供公司登記證明，原登錄者無法證明' }, t.deps);
    expect(result).toMatchObject({ status: 'resolved', decision: 'to_claimant' });

    expect(await mine(a)).toBeNull();
    expect((await mine(b))?.licenses[0]).toMatchObject({ permitNo: '認領方的字號', phase: 'awaiting_review' });
    const evidence = await t.registry<{ org_id: string; subject_type: string; state: string; delete_reason: string | null }>(
      'SELECT org_id, subject_type, state, delete_reason FROM vault.credential_evidence ORDER BY uploaded_at, id',
    );
    expect(evidence).toEqual([
      { org_id: a.orgId, subject_type: 'license', state: 'deleted', delete_reason: 'superseded' },
      { org_id: b.orgId, subject_type: 'license', state: 'stored', delete_reason: null },
    ]);
    const open = await t.registry<{ type: string }>("SELECT type FROM registry.review_items WHERE status = 'open'");
    expect(open).toEqual([{ type: 'license' }]);
  });

  it('執業主體還有已驗證的業別時不能改歸屬', async () => {
    const { a, b, op } = await claimSetup();
    await submit(a);
    await recordCheckFlow(op.run, await openItemId(a), matchForm(), t.deps);
    await submit(b);
    const claimId = (await t.registry<{ id: string }>("SELECT id FROM registry.review_items WHERE type = 'entity_claim'"))[0].id;
    expect(await resolveClaimFlow(op.run, claimId, { decision: 'to_claimant', note: '測試' }, t.deps)).toEqual({ status: 'has_verified_license' });
    // 直接打資料庫函式也擋得住
    await expect(
      op.run('desk:x', (tx) => tx.query("SELECT * FROM registry.resolve_entity_claim($1, 'to_claimant', 'x', ARRAY['01ARZ3NDEKTSV4RRFFQ69G5FAV'], ARRAY['01ARZ3NDEKTSV4RRFFQ69G5FAW'], $2, 1)", [claimId, PLATFORM_ORG_ID])),
    ).rejects.toThrow(/已驗證的業別/);
  });

  it('判定必須寫理由與選擇結果', async () => {
    const { b, op } = await claimSetup();
    void b;
    expect(await resolveClaimFlow(op.run, 'x', { decision: 'to_claimant', note: ' ' }, t.deps)).toMatchObject({ status: 'invalid', field: 'note' });
    expect(await resolveClaimFlow(op.run, 'x', { decision: 'maybe', note: 'x' }, t.deps)).toMatchObject({ status: 'invalid', field: 'decision' });
  });
});

describe('批次查詢', () => {
  it('以 ID 清單一次查詢：名稱、法定稱謂、各業別驗證狀態；查無的 ID 不出現；順序依傳入', async () => {
    const a = await t.practiceAccount('a@example.com', { kinds: ['management'] });
    const b = await t.practiceAccount('b@example.com', { name: '乙經紀公司', taxId: '22222222', kinds: ['brokerage'] });
    const owner = await t.practiceAccount('c@example.com', { name: '丙', taxId: '33333333', kinds: ['management', 'master_lease'] });
    const op = await t.operatorAccount();
    await submit(a);
    await recordCheckFlow(op.run, await openItemId(a), matchForm(), t.deps);
    const ids = await t.registry<{ id: string; name: string }>('SELECT id, name FROM registry.practice_entities');
    const idOf = (name: string) => ids.find((i) => i.name === name)!.id;

    const result = await withTx({ kind: 'org', orgId: b.orgId }, (tx) =>
      lookupPracticeEntities(tx, [idOf('乙經紀公司'), '01ARZ3NDEKTSV4RRFFQ69G5FAV', idOf('安心代管有限公司'), idOf('丙')], { businessType: 'managed' }),
    );
    void owner;
    expect(result.map((r) => r.name)).toEqual(['乙經紀公司', '安心代管有限公司', '丙']);
    expect(result[0]).toMatchObject({ title: '不動產經紀業者', hasVerifiedLicense: false, licenses: [{ kind: 'brokerage', state: 'pending' }] });
    expect(result[1]).toMatchObject({ title: '租賃住宅代管業者', hasVerifiedLicense: true, licenses: [{ kind: 'management', title: '租賃住宅代管業者', state: 'verified' }] });
    // 兼營：給了業務類型 managed，稱謂由業務類型決定
    expect(result[2].title).toBe('租賃住宅代管業者');
    expect(result[2].licenses.map((l) => l.kind)).toEqual(['management', 'master_lease']);
  });

  it('兼營又沒給業務類型時 title 是 null，不猜稱謂', async () => {
    const c = await t.practiceAccount('c@example.com', { kinds: ['management', 'master_lease'] });
    const id = (await t.registry<{ id: string }>('SELECT id FROM registry.practice_entities'))[0].id;
    const [row] = await withTx({ kind: 'org', orgId: c.orgId }, (tx) => lookupPracticeEntities(tx, [id]));
    expect(row.title).toBeNull();
  });

  it('回應只有 ID、名稱、稱謂、業別與狀態：不含統編、組織 ID、人員', async () => {
    const a = await t.practiceAccount('a@example.com');
    const b = await t.practiceAccount('b@example.com', { taxId: '22222222', name: '乙公司' });
    const id = (await t.registry<{ id: string }>('SELECT id FROM registry.practice_entities WHERE tax_id = $1', ['12345678']))[0].id;
    const result = await withTx({ kind: 'org', orgId: b.orgId }, (tx) => lookupPracticeEntities(tx, [id]));
    const text = JSON.stringify(result);
    expect(text).not.toContain('12345678');
    expect(text).not.toContain(a.orgId);
    expect(text).not.toContain(a.userId);
    expect(Object.keys(result[0]).sort()).toEqual(['hasVerifiedLicense', 'id', 'licenses', 'name', 'title']);
  });

  it('一次最多 500 個 ID；沒有組織脈絡不能查', async () => {
    const a = await t.practiceAccount('a@example.com');
    const many = Array.from({ length: 501 }, (_, i) => String(i).padStart(26, '0'));
    await expect(withTx({ kind: 'org', orgId: a.orgId }, (tx) => lookupPracticeEntities(tx, many))).rejects.toThrow(/最多查 500/);
    await expect(withTx({ kind: 'control' }, (tx) => tx.query("SELECT * FROM registry.lookup_practice_entities(ARRAY['x'])"))).rejects.toThrow(/組織脈絡/);
  });
});

describe('審查後補的防線', () => {
  it('SQL 函式不收 NULL 的狀態與結果：NULL 讓比較變成 NULL，檢查會被跳過，所以資料庫要明確拒絕', async () => {
    const a = await t.practiceAccount('a@example.com');
    const op = await t.operatorAccount();
    await submit(a);
    const licenseId = (await t.registry<{ id: string }>('SELECT id FROM registry.practice_licenses'))[0].id;
    const call = (result: string | null, expected: string | null) =>
      op.run('desk:x', (tx) =>
        tx.query(
          `SELECT registry.record_license_check('01ARZ3NDEKTSV4RRFFQ69G5FAV', NULL, $1, 'gcis_manual', 'x', '{}', $2, ARRAY[]::text[], '', $3, 'verified', NULL, NULL, $4, 1, NULL)`,
          [licenseId, result, expected, PLATFORM_ORG_ID],
        ),
      );
    await expect(call('match', null)).rejects.toThrow(/不得為空/);
    await expect(call(null, 'pending')).rejects.toThrow(/不得為空/);
    await expect(
      op.run('desk:x', (tx) => tx.query("SELECT * FROM registry.resolve_entity_claim('x', NULL, 'x', ARRAY[]::text[], ARRAY[]::text[], 'c', 1)")),
    ).rejects.toThrow(/keep_registrant 或 to_claimant/);
    expect((await mine(a))?.licenses[0].state).toBe('pending');
  });

  it('核對期間執業主體改了證字號：資料庫拒絕（40001），新字號不會在沒人核對時轉成已驗證', async () => {
    const a = await t.practiceAccount('a@example.com');
    const op = await t.operatorAccount();
    await submit(a, { permitNo: '舊字號' });
    const itemId = await openItemId(a);
    const licenseId = (await t.registry<{ id: string }>('SELECT id FROM registry.practice_licenses'))[0].id;
    await submit(a, { permitNo: '新字號' });
    await expect(
      op.run('desk:x', (tx) =>
        tx.query(
          `SELECT registry.record_license_check('01ARZ3NDEKTSV4RRFFQ69G5FAV', $1, $2, 'gcis_manual', 'x', '{}', 'match', ARRAY[]::text[], '', 'pending', 'verified', NULL, NULL, $3, 1, '舊字號')`,
          [itemId, licenseId, PLATFORM_ORG_ID],
        ),
      ),
    ).rejects.toMatchObject({ code: '40001' });
    expect((await mine(a))?.licenses[0]).toMatchObject({ state: 'pending', permitNo: '新字號' });
  });

  it('判定歸屬給認領方之後，認領方看不到原登錄者時期的判定理由', async () => {
    const a = await t.practiceAccount('a@example.com', { name: '同名公司' });
    const b = await t.practiceAccount('b@example.com', { name: '同名公司' });
    const op = await t.operatorAccount();
    await submit(a);
    await recordCheckFlow(op.run, await openItemId(a), matchForm({ result: 'mismatch', note: '原登錄者才看得到的理由' }), t.deps);
    await submit(b, { permitNo: '認領方字號' });
    const claimId = (await t.registry<{ id: string }>("SELECT id FROM registry.review_items WHERE type = 'entity_claim'"))[0].id;
    await resolveClaimFlow(op.run, claimId, { decision: 'to_claimant', note: '認領方提供登記證明' }, t.deps);

    expect((await mine(b))?.licenses[0]).toMatchObject({ phase: 'awaiting_review', lastResult: null, lastNote: null });
    expect(JSON.stringify(await mine(b))).not.toContain('原登錄者才看得到的理由');
  });

  it('認領判定的稽核位置存在項目裡', async () => {
    await t.practiceAccount('a@example.com', { name: '同名公司' });
    await t.practiceAccount('b@example.com', { name: '同名公司' });
    const op = await t.operatorAccount();
    const claimId = (await t.registry<{ id: string }>("SELECT id FROM registry.review_items WHERE type = 'entity_claim'"))[0].id;
    await resolveClaimFlow(op.run, claimId, { decision: 'keep_registrant', note: '維持原登錄者' }, t.deps);
    const payload = (await t.registry<{ payload: Record<string, unknown> }>('SELECT payload FROM registry.review_items WHERE id = $1', [claimId]))[0].payload;
    expect(payload).toMatchObject({ audit_chain_id: PLATFORM_ORG_ID, resolution_note: '維持原登錄者' });
    expect(Number(payload.audit_seq)).toBeGreaterThan(0);
  });

  it('登記狀態不是核准設立時選「相符」被拒，已驗證的其他業別維持原狀（要轉失效請改選已廢止）', async () => {
    const a = await t.practiceAccount('a@example.com', { kinds: ['management', 'master_lease'] });
    const op = await t.operatorAccount();
    await submit(a, { kind: 'management' });
    await recordCheckFlow(op.run, await openItemId(a, 'management'), matchForm(), t.deps);
    await submit(a, { kind: 'master_lease', permitNo: '包租字第 1 號' });
    const itemId = await openItemId(a, 'master_lease');
    expect(await recordCheckFlow(op.run, itemId, matchForm({ registrationStatus: '廢止', businessItemCodes: ['H706021'] }), t.deps)).toMatchObject({
      status: 'registration_not_approved',
    });
    expect((await t.registry<{ state: string }>("SELECT state FROM registry.practice_licenses WHERE kind = 'management'"))[0].state).toBe('verified');
  });
});
