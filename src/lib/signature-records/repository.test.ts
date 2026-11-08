import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, insertContractWithEvent } from '../db';
import { insertSignTask } from '../signing-module/sign-task-store';
import {
  completeSignSnapshot,
  insertSignatureRecords,
  listPendingSignRecords,
  listSignatureRecords,
} from './repository';
import type { SignatureRecordInput } from './types';
import { buildCredentialSnapshot } from './snapshot';
import { createSeedPracticeRegistry } from '../practice-registry';

// 簽章紀錄的 repository（MIL-70）：只為執業人員寫一列、參照簽署人列、寫入後不得修改。

let db: Database.Database;
let contractId: number;

const AT_SEND = '2026-11-09T12:00:00+08:00';
const AT_SIGN = '2026-11-10T09:30:00+08:00';
const RULE_ID = 'lease.master_lease.practitioner';

async function inputOf(overrides: Partial<SignatureRecordInput> = {}): Promise<SignatureRecordInput> {
  const registry = createSeedPracticeRegistry({ today: () => '2026-11-09' });
  const chen = (await registry.getPractitioner('pr-chen', { licenseKind: 'master_lease' }))!;
  return {
    signerIndex: 1,
    ruleId: RULE_ID,
    statuteRef: '租賃條例 §32 第 2、3 款',
    ruleVersion: 1,
    practitionerId: 'pr-chen',
    employmentId: chen.employmentId,
    entityId: 'org-pe-beichen',
    licenseKind: 'master_lease',
    concurrentRoles: [],
    snapshotAtSend: buildCredentialSnapshot(chen, AT_SEND),
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  contractId = insertContractWithEvent({ property_id: null, fields: '{}' }, { type: 'created', actor: 'landlord' }, db);
  insertSignTask(db, {
    provider: 'mock',
    taskRef: 'task-1',
    subject: { type: 'contract', id: contractId },
    signers: [
      { role: 'party_b', name: '王租客', email: 'tenant@example.com' },
      { role: 'practitioner', name: '陳怡君', email: 'chen.yijun@beichen.example.com' },
      { role: 'party_a', name: '王建國', email: 'wang@example.com' },
    ],
  });
});
afterEach(() => db.close());

describe('寫入與讀回', () => {
  it('只為執業人員寫一列，並參照簽署人列', async () => {
    insertSignatureRecords(db, contractId, [await inputOf()]);
    const records = await listSignatureRecords(contractId, db);
    expect(records).toHaveLength(1);
    const signer = db.prepare('SELECT id, role, email FROM signers WHERE id = ?').get(records[0].signerId) as {
      role: string;
      email: string;
    };
    expect(signer).toMatchObject({ role: 'practitioner', email: 'chen.yijun@beichen.example.com' });
  });

  it('法定欄位齊全：款次、規則、版本、執業人員、任職、執業主體、兼任角色', async () => {
    insertSignatureRecords(db, contractId, [await inputOf({ concurrentRoles: ['party_a'] })]);
    const [record] = await listSignatureRecords(contractId, db);
    expect(record).toMatchObject({
      contractId,
      statuteRef: '租賃條例 §32 第 2、3 款',
      ruleId: RULE_ID,
      ruleVersion: 1,
      practitionerId: 'pr-chen',
      employmentId: 'emp-pr-chen',
      entityId: 'org-pe-beichen',
      concurrentRoles: ['party_a'],
    });
  });

  it('送簽時就有 snapshot_at_send，snapshot_at_sign 還是空的', async () => {
    insertSignatureRecords(db, contractId, [await inputOf()]);
    const [record] = await listSignatureRecords(contractId, db);
    expect(record.snapshotAtSend.decidedAt).toBe(AT_SEND);
    expect(record.snapshotAtSign).toBeNull();
  });

  it('沒有兼任時兼任角色是空陣列', async () => {
    insertSignatureRecords(db, contractId, [await inputOf()]);
    expect((await listSignatureRecords(contractId, db))[0].concurrentRoles).toEqual([]);
  });

  it('簽署人位置不存在時拒絕寫入', async () => {
    const orphan = await inputOf({ signerIndex: 9 });
    expect(() => insertSignatureRecords(db, contractId, [orphan])).toThrow();
    expect(await listSignatureRecords(contractId, db)).toEqual([]);
  });
});

describe('補 snapshot_at_sign', () => {
  it('補一次，其他欄位與 snapshot_at_send 不變', async () => {
    insertSignatureRecords(db, contractId, [await inputOf()]);
    const [before] = await listSignatureRecords(contractId, db);
    const registry = createSeedPracticeRegistry({ today: () => '2026-11-10' });
    const chen = (await registry.getPractitioner('pr-chen', { licenseKind: 'master_lease' }))!;
    const written = completeSignSnapshot(db, contractId, RULE_ID, buildCredentialSnapshot(chen, AT_SIGN));
    expect(written).toBe(true);
    const [after] = await listSignatureRecords(contractId, db);
    expect(after.snapshotAtSign?.decidedAt).toBe(AT_SIGN);
    expect({ ...after, snapshotAtSign: null }).toEqual({ ...before, snapshotAtSign: null });
  });

  it('已補過就不再寫入，回 false', async () => {
    insertSignatureRecords(db, contractId, [await inputOf()]);
    const first = buildCredentialSnapshot(
      (await createSeedPracticeRegistry({ today: () => '2026-11-09' }).getPractitioner('pr-chen', { licenseKind: 'master_lease' }))!,
      AT_SIGN,
    );
    expect(completeSignSnapshot(db, contractId, RULE_ID, first)).toBe(true);
    expect(completeSignSnapshot(db, contractId, RULE_ID, { ...first, decidedAt: '2030-01-01T00:00:00+08:00' })).toBe(false);
    expect((await listSignatureRecords(contractId, db))[0].snapshotAtSign?.decidedAt).toBe(AT_SIGN);
  });

  it('待補清單帶簽署人 email，已補的不在清單內', async () => {
    insertSignatureRecords(db, contractId, [await inputOf()]);
    expect(listPendingSignRecords(db, contractId)).toEqual([
      { ruleId: RULE_ID, practitionerId: 'pr-chen', licenseKind: 'master_lease', signerEmail: 'chen.yijun@beichen.example.com' },
    ]);
    completeSignSnapshot(db, contractId, RULE_ID, { decidedAt: AT_SIGN, unavailable: true, reason: 'x' });
    expect(listPendingSignRecords(db, contractId)).toEqual([]);
  });
});

describe('寫入後不得修改（資料庫層擋下，不只是 repository 沒有開放）', () => {
  async function seeded() {
    insertSignatureRecords(db, contractId, [await inputOf()]);
  }

  it.each([
    ['statute_ref', "'x'"],
    ['rule_id', "'x'"],
    ['rule_version', '9'],
    ['practitioner_id', "'x'"],
    ['employment_id', "'x'"],
    ['entity_id', "'x'"],
    ['license_kind', "'x'"],
    ['concurrent_roles', "'[\"party_a\"]'"],
    ['signer_id', '999'],
    ['contract_id', '999'],
    ['snapshot_at_send', "'{}'"],
  ])('改 %s 被擋下', async (column, value) => {
    await seeded();
    expect(() => db.prepare(`UPDATE signature_records SET ${column} = ${value}`).run()).toThrow(/簽章紀錄/);
  });

  it('snapshot_at_sign 補上之後不得再改或清空', async () => {
    await seeded();
    completeSignSnapshot(db, contractId, RULE_ID, { decidedAt: AT_SIGN, unavailable: true, reason: 'x' });
    expect(() => db.prepare("UPDATE signature_records SET snapshot_at_sign = '{}'").run()).toThrow(/簽章紀錄/);
    expect(() => db.prepare('UPDATE signature_records SET snapshot_at_sign = NULL').run()).toThrow(/簽章紀錄/);
  });

  it('不得刪除', async () => {
    await seeded();
    expect(() => db.prepare('DELETE FROM signature_records').run()).toThrow(/簽章紀錄/);
  });

  it('同一份合約同一席位只有一列', async () => {
    await seeded();
    const again = await inputOf();
    expect(() => insertSignatureRecords(db, contractId, [again])).toThrow();
  });
});
