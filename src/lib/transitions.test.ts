import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendContractEvent,
  commitTransition,
  copyContractAsDraft,
  ensureSchema,
  insertContractWithEvent,
  listContractEvents,
} from './db';
import { applySigningResult, decideTransition } from './transitions';
import type { Contract, ContractStatus } from './types';

let db: Database.Database;

// 測試用 in-memory DB：不碰 data/ 下的檔案
beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
});

afterEach(() => {
  db.close();
});

function seedContract(status: ContractStatus): Contract {
  const result = db
    .prepare("INSERT INTO contracts (property_id, status, fields) VALUES (NULL, ?, '{}')")
    .run(status);
  return { id: Number(result.lastInsertRowid), status } as Contract;
}

function statusOf(id: number): ContractStatus {
  return (db.prepare('SELECT status FROM contracts WHERE id = ?').get(id) as { status: ContractStatus }).status;
}

const PARTY_A = { role: 'party_a', name: '林房東', email: 'landlord@example.com' } as const;
const PARTY_B = { role: 'party_b', name: '王租客', email: 'tenant@example.com' } as const;
const PRACTITIONER = { role: 'practitioner', name: '陳管理', email: 'manager@example.com' } as const;

describe('decideTransition：自管租賃合約的轉移意義不變（PRD P0-10 AC7）', () => {
  it('送簽：草稿依第一位簽署人的角色進入簽署中，記送簽事件', () => {
    expect(decideTransition('draft', { type: 'sent', first: PARTY_B })).toEqual({
      status: 'awaiting_tenant',
      event: { type: 'sent', actor: 'landlord', note: '寄送給乙方 tenant@example.com' },
    });
  });

  it('乙方簽完：進入待甲方簽，記簽署人簽署事件，行為者是乙方', () => {
    expect(decideTransition('awaiting_tenant', { type: 'signer_signed', signer: PARTY_B, next: PARTY_A })).toEqual({
      status: 'awaiting_landlord',
      event: { type: 'signer_signed', actor: 'party_b', note: null },
    });
  });

  it('甲方是最後一位：不改合約狀態，也不寫合約歷程', () => {
    expect(
      decideTransition('awaiting_landlord', { type: 'signer_signed', signer: PARTY_A, next: null })
    ).toBeNull();
  });

  it.each(['awaiting_tenant', 'awaiting_landlord', 'awaiting_practitioner'] as const)(
    '%s 全員完成：進入已完成，記簽署完成事件',
    (status) => {
      expect(decideTransition(status, { type: 'completed' })).toEqual({
        status: 'completed',
        event: { type: 'completed', actor: 'system', note: null },
      });
    }
  );

  it('拒簽帶原因：事件附註記下原因，行為者是拒簽的簽署人', () => {
    expect(
      decideTransition('awaiting_tenant', { type: 'declined', signer: PARTY_B, reason: '租金認知有落差' })
    ).toEqual({
      status: 'declined',
      event: { type: 'declined', actor: 'party_b', note: '租金認知有落差' },
    });
    expect(decideTransition('awaiting_landlord', { type: 'declined', signer: PARTY_A })).toEqual({
      status: 'declined',
      event: { type: 'declined', actor: 'party_a', note: null },
    });
  });

  it('拒簽時沒有當前簽署人：行為者是系統', () => {
    expect(decideTransition('awaiting_landlord', { type: 'declined', signer: null })).toMatchObject({
      event: { type: 'declined', actor: 'system' },
    });
  });

  it('撤回：由房東發動', () => {
    expect(decideTransition('awaiting_tenant', { type: 'voided' })).toEqual({
      status: 'voided',
      event: { type: 'voided', actor: 'landlord', note: null },
    });
  });

  it.each(['draft', 'completed', 'declined', 'voided'] as const)('%s 不接受任何簽署結果', (status) => {
    expect(decideTransition(status, { type: 'signer_signed', signer: PARTY_B, next: PARTY_A })).toBeNull();
    expect(decideTransition(status, { type: 'completed' })).toBeNull();
    expect(decideTransition(status, { type: 'declined', signer: PARTY_B })).toBeNull();
    expect(decideTransition(status, { type: 'voided' })).toBeNull();
  });

  it.each(['awaiting_tenant', 'awaiting_landlord', 'completed', 'declined', 'voided'] as const)(
    '%s 不能再送簽',
    (status) => {
      expect(decideTransition(status, { type: 'sent', first: PARTY_B })).toBeNull();
    }
  );
});

describe('decideTransition：合約狀態由簽署角色投影', () => {
  it.each([
    [PARTY_B, 'awaiting_tenant', '寄送給乙方 tenant@example.com'],
    [PARTY_A, 'awaiting_landlord', '寄送給甲方 landlord@example.com'],
    [PRACTITIONER, 'awaiting_practitioner', '寄送給執業人員 manager@example.com'],
  ] as const)('第一位是 $role 時，送簽後進入 %s', (first, status, note) => {
    expect(decideTransition('draft', { type: 'sent', first })).toEqual({
      status,
      event: { type: 'sent', actor: 'landlord', note },
    });
  });

  it.each([
    ['awaiting_tenant', PARTY_B, PRACTITIONER, 'awaiting_practitioner'],
    ['awaiting_practitioner', PRACTITIONER, PARTY_A, 'awaiting_landlord'],
    ['awaiting_landlord', PARTY_A, PARTY_B, 'awaiting_tenant'],
  ] as const)('%s 由目前簽署人簽完後，依下一位的角色進入 %s', (status, signer, next, expected) => {
    expect(decideTransition(status, { type: 'signer_signed', signer, next })).toEqual({
      status: expected,
      event: { type: 'signer_signed', actor: signer.role, note: null },
    });
  });

  it('執業人員拒簽：行為者是執業人員', () => {
    expect(decideTransition('awaiting_practitioner', { type: 'declined', signer: PRACTITIONER })).toMatchObject({
      status: 'declined',
      event: { actor: 'practitioner' },
    });
  });
});

describe('applySigningResult（狀態轉移與歷程事件同交易）', () => {
  it('走完一輪簽署流程後，事件序列與狀態一致', () => {
    const contract = seedContract('draft');
    appendContractEvent(contract.id, { type: 'created', actor: 'landlord' }, db);

    applySigningResult(contract, { type: 'sent', first: PARTY_B }, db);
    applySigningResult(
      { ...contract, status: 'awaiting_tenant' },
      { type: 'signer_signed', signer: PARTY_B, next: PARTY_A },
      db
    );
    applySigningResult(
      { ...contract, status: 'awaiting_landlord' },
      { type: 'signer_signed', signer: PARTY_A, next: null },
      db
    );
    applySigningResult({ ...contract, status: 'awaiting_landlord' }, { type: 'completed' }, db);

    expect(statusOf(contract.id)).toBe('completed');
    expect(listContractEvents(contract.id, db).map((e) => [e.type, e.actor])).toEqual([
      ['created', 'landlord'],
      ['sent', 'landlord'],
      ['signer_signed', 'party_b'],
      ['completed', 'system'],
    ]);
  });

  it('拒簽事件寫入原因附註，合約也留下拒簽原因', () => {
    const contract = seedContract('awaiting_tenant');
    applySigningResult(contract, { type: 'declined', signer: PARTY_B, reason: '租金認知有落差' }, db);

    const events = listContractEvents(contract.id, db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'declined', actor: 'party_b', note: '租金認知有落差' });
    expect(
      (db.prepare('SELECT declined_reason FROM contracts WHERE id=?').get(contract.id) as { declined_reason: string })
        .declined_reason
    ).toBe('租金認知有落差');
  });

  it('沒有轉移時不改狀態也不寫事件，回傳 null', () => {
    const contract = seedContract('draft');
    expect(applySigningResult(contract, { type: 'completed' }, db)).toBeNull();
    expect(statusOf(contract.id)).toBe('draft');
    expect(listContractEvents(contract.id, db)).toHaveLength(0);
  });

  it('事件寫入失敗時，狀態一起回滾', () => {
    const contract = seedContract('awaiting_tenant');
    // 模擬歷程寫入失敗（磁碟錯誤、約束違反等）
    db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON contract_events BEGIN SELECT RAISE(ABORT, '寫入失敗'); END;");

    expect(() => applySigningResult(contract, { type: 'completed' }, db)).toThrow();

    db.exec('DROP TRIGGER fail_event');
    expect(statusOf(contract.id)).toBe('awaiting_tenant');
    expect(listContractEvents(contract.id, db)).toHaveLength(0);
  });

  it('狀態轉移失敗時，事件也不會留下', () => {
    const contract = seedContract('awaiting_tenant');
    db.exec("CREATE TRIGGER fail_status BEFORE UPDATE ON contracts BEGIN SELECT RAISE(ABORT, '更新失敗'); END;");

    expect(() => applySigningResult(contract, { type: 'completed' }, db)).toThrow();

    db.exec('DROP TRIGGER fail_status');
    expect(statusOf(contract.id)).toBe('awaiting_tenant');
    expect(listContractEvents(contract.id, db)).toHaveLength(0);
  });
});

describe('系統側動作的歷程事件', () => {
  function loadContract(id: number): Contract {
    const row = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) as {
      id: number;
      property_id: number | null;
      status: ContractStatus;
      fields: string;
      signature_fields: string;
    };
    return {
      ...row,
      fields: JSON.parse(row.fields),
      signature_fields: JSON.parse(row.signature_fields),
    } as Contract;
  }

  it('建立合約寫入「建立」事件', () => {
    const id = insertContractWithEvent(
      { property_id: null, fields: '{}' },
      { type: 'created', actor: 'landlord' },
      db
    );
    expect(listContractEvents(id, db)).toMatchObject([{ type: 'created', actor: 'landlord', note: null }]);
  });

  it('送簽把狀態與「送簽」事件一起寫入', () => {
    const id = insertContractWithEvent({ property_id: null, fields: '{}' }, { type: 'created', actor: 'landlord' }, db);
    commitTransition(
      id,
      {
        status: 'awaiting_tenant',
        event: { type: 'sent', actor: 'landlord', note: '寄送給乙方 tenant@example.com' },
      },
      db
    );

    expect(statusOf(id)).toBe('awaiting_tenant');
    expect(listContractEvents(id, db).map((e) => e.type)).toEqual(['created', 'sent']);
  });

  it('撤回後複製：來源記「被複製為新草稿」，新約的「建立」附註衍生來源', () => {
    const sourceId = seedContract('voided').id;
    const newId = copyContractAsDraft(loadContract(sourceId), db);

    expect(listContractEvents(sourceId, db)).toMatchObject([
      { type: 'copied', actor: 'landlord', note: `複製為新草稿：合約 #${newId}` },
    ]);
    expect(listContractEvents(newId, db)).toMatchObject([
      { type: 'created', actor: 'landlord', note: `衍生自合約 #${sourceId}（撤回後修約）` },
    ]);
  });

  it('拒簽後複製不記衍生來源（ADR-0006：拒簽是交易終點）', () => {
    const sourceId = seedContract('declined').id;
    const newId = copyContractAsDraft(loadContract(sourceId), db);

    expect(listContractEvents(newId, db)).toMatchObject([{ type: 'created', actor: 'landlord', note: null }]);
    expect(listContractEvents(sourceId, db).map((e) => e.type)).toEqual(['copied']);
  });
});

describe('合約歷程 append-only', () => {
  it('事件依發生順序回傳，且只有新增入口', () => {
    const contract = seedContract('draft');
    appendContractEvent(contract.id, { type: 'created', actor: 'landlord', note: '衍生自合約 #7（撤回後修約）' }, db);
    appendContractEvent(contract.id, { type: 'sent', actor: 'landlord' }, db);

    const events = listContractEvents(contract.id, db);
    expect(events.map((e) => e.type)).toEqual(['created', 'sent']);
    expect(events[0].note).toBe('衍生自合約 #7（撤回後修約）');
    expect(events[0].created_at).toBeTruthy();
  });

  it('只回傳指定合約的事件', () => {
    const a = seedContract('draft');
    const b = seedContract('draft');
    appendContractEvent(a.id, { type: 'created', actor: 'landlord' }, db);
    appendContractEvent(b.id, { type: 'created', actor: 'landlord' }, db);
    appendContractEvent(b.id, { type: 'copied', actor: 'landlord', note: '複製為新草稿：合約 #3' }, db);

    expect(listContractEvents(a.id, db)).toHaveLength(1);
    expect(listContractEvents(b.id, db)).toHaveLength(2);
  });
});
