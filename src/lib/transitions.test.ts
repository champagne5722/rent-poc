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
import { applyDsEvent, decideTransition } from './transitions';
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
    .prepare("INSERT INTO contracts (property_id, status, fields, dottedsign_task_id) VALUES (NULL, ?, '{}', 'task-1')")
    .run(status);
  return { id: Number(result.lastInsertRowid), status } as Contract;
}

function statusOf(id: number): ContractStatus {
  return (db.prepare('SELECT status FROM contracts WHERE id = ?').get(id) as { status: ContractStatus }).status;
}

describe('decideTransition（純轉移邏輯）', () => {
  it('待乙方簽收到 signed：進入待甲方簽，記乙方簽署事件', () => {
    expect(decideTransition('awaiting_tenant', 'signed')).toEqual({
      status: 'awaiting_landlord',
      event: { type: 'tenant_signed', actor: 'tenant', note: null },
    });
  });

  it('待甲方簽收到 signed：不轉移（甲方簽完會跟著 completed 事件）', () => {
    expect(decideTransition('awaiting_landlord', 'signed')).toBeNull();
  });

  it('待甲方簽收到 completed：進入已完成，記甲方簽署完成事件', () => {
    expect(decideTransition('awaiting_landlord', 'completed')).toEqual({
      status: 'completed',
      event: { type: 'completed', actor: 'landlord', note: null },
    });
  });

  it('拒簽帶原因：事件附註記下原因，行為者依當前待簽方判定', () => {
    expect(decideTransition('awaiting_tenant', 'declined', '租金認知有落差')).toEqual({
      status: 'declined',
      event: { type: 'declined', actor: 'tenant', note: '租金認知有落差' },
    });
    expect(decideTransition('awaiting_landlord', 'declined', '房東改變主意')).toEqual({
      status: 'declined',
      event: { type: 'declined', actor: 'landlord', note: '房東改變主意' },
    });
  });

  it('撤回：由房東發動', () => {
    expect(decideTransition('awaiting_tenant', 'voided')).toEqual({
      status: 'voided',
      event: { type: 'voided', actor: 'landlord', note: null },
    });
  });

  it.each(['draft', 'completed', 'declined', 'voided'] as const)('%s 不接受任何點點簽事件', (status) => {
    for (const event of ['signed', 'completed', 'declined', 'voided'] as const) {
      expect(decideTransition(status, event)).toBeNull();
    }
  });
});

describe('applyDsEvent（狀態轉移與歷程事件同交易）', () => {
  it('走完一輪簽署流程後，事件序列與狀態一致', () => {
    const contract = seedContract('draft');
    appendContractEvent(contract.id, { type: 'created', actor: 'landlord' }, db);
    appendContractEvent(contract.id, { type: 'sent', actor: 'landlord' }, db);
    db.prepare("UPDATE contracts SET status='awaiting_tenant' WHERE id=?").run(contract.id);

    expect(applyDsEvent({ ...contract, status: 'awaiting_tenant' }, 'signed', undefined, db)).toBe('awaiting_landlord');
    expect(applyDsEvent({ ...contract, status: 'awaiting_landlord' }, 'completed', undefined, db)).toBe('completed');

    expect(statusOf(contract.id)).toBe('completed');
    expect(listContractEvents(contract.id, db).map((e) => [e.type, e.actor])).toEqual([
      ['created', 'landlord'],
      ['sent', 'landlord'],
      ['tenant_signed', 'tenant'],
      ['completed', 'landlord'],
    ]);
  });

  it('拒簽事件寫入原因附註，合約也留下拒簽原因', () => {
    const contract = seedContract('awaiting_tenant');
    expect(applyDsEvent(contract, 'declined', '租金認知有落差', db)).toBe('declined');

    const events = listContractEvents(contract.id, db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'declined', actor: 'tenant', note: '租金認知有落差' });
    expect(
      (db.prepare('SELECT declined_reason FROM contracts WHERE id=?').get(contract.id) as { declined_reason: string })
        .declined_reason
    ).toBe('租金認知有落差');
  });

  it('狀態不接受該事件時不轉移也不寫事件', () => {
    const contract = seedContract('draft');
    expect(applyDsEvent(contract, 'signed', undefined, db)).toBeNull();
    expect(statusOf(contract.id)).toBe('draft');
    expect(listContractEvents(contract.id, db)).toHaveLength(0);
  });

  it('事件寫入失敗時，狀態一起回滾', () => {
    const contract = seedContract('awaiting_tenant');
    // 模擬歷程寫入失敗（磁碟錯誤、約束違反等）
    db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON contract_events BEGIN SELECT RAISE(ABORT, '寫入失敗'); END;");

    expect(() => applyDsEvent(contract, 'signed', undefined, db)).toThrow();

    db.exec('DROP TRIGGER fail_event');
    expect(statusOf(contract.id)).toBe('awaiting_tenant');
    expect(listContractEvents(contract.id, db)).toHaveLength(0);
  });

  it('狀態轉移失敗時，事件也不會留下', () => {
    const contract = seedContract('awaiting_tenant');
    db.exec("CREATE TRIGGER fail_status BEFORE UPDATE ON contracts BEGIN SELECT RAISE(ABORT, '更新失敗'); END;");

    expect(() => applyDsEvent(contract, 'signed', undefined, db)).toThrow();

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

  it('送簽把狀態、task_id 與「送簽」事件一起寫入', () => {
    const id = insertContractWithEvent({ property_id: null, fields: '{}' }, { type: 'created', actor: 'landlord' }, db);
    commitTransition(
      id,
      {
        status: 'awaiting_tenant',
        event: { type: 'sent', actor: 'landlord', note: '寄送給乙方 tenant@example.com' },
        dottedsignTaskId: 'task-42',
      },
      db
    );

    const row = db.prepare('SELECT status, dottedsign_task_id FROM contracts WHERE id=?').get(id) as {
      status: string;
      dottedsign_task_id: string;
    };
    expect(row).toEqual({ status: 'awaiting_tenant', dottedsign_task_id: 'task-42' });
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
