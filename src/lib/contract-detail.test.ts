import { describe, expect, it } from 'vitest';
import type { Contract, ContractEvent, ContractFile, ContractStatus } from './types';
import { CONTRACT_EVENT_TYPES, CONTRACT_STATUSES } from './types';
import {
  contractChainNodes,
  contractEventEntries,
  contractEventTypeLabel,
  contractFileRows,
  detailActions,
} from './contract-detail';

function makeContract(o: { id?: number; status?: ContractStatus; derived_from?: number | null } = {}): Contract {
  return {
    id: o.id ?? 1,
    property_id: null,
    derived_from: o.derived_from ?? null,
    status: o.status ?? 'draft',
    fields: {
      landlordName: '林房東',
      landlordEmail: 'landlord@example.com',
      tenantName: '王租客',
      tenantEmail: 'tenant@example.com',
      propertyName: '測試物件',
      propertyAddress: '台北市測試路 1 號',
      propertyType: '套房',
      propertySize: 10,
      equipment: [],
      rent: 15000,
      deposit: 30000,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      payDay: 5,
      extra: '',
    },
    signature_fields: [],
    dottedsign_task_id: null,
    declined_reason: null,
    created_at: '2026-01-01 09:00:00',
    updated_at: null,
  };
}

function makeEvent(o: Partial<ContractEvent> & { id: number }): ContractEvent {
  return {
    contract_id: 1,
    type: 'created',
    actor: 'landlord',
    note: null,
    created_at: '2026-01-01 09:00:00',
    ...o,
  };
}

function makeFile(o: Partial<ContractFile> & { kind: ContractFile['kind'] }): ContractFile {
  return {
    id: 1,
    contract_id: 1,
    status: 'saved',
    file_name: 'contract-1-signed.pdf',
    rel_path: 'contract-files/1/contract-1-signed.pdf',
    byte_size: 1024,
    content_type: 'application/pdf',
    error: null,
    saved_at: '2026-01-03 10:00:00',
    ...o,
  };
}

describe('detailActions', () => {
  it('草稿只有繼續編輯，連到 wizard', () => {
    const actions = detailActions('draft', { mock: false });
    expect(actions.map((a) => a.key)).toEqual(['edit']);
    expect(actions[0].label).toBe('繼續編輯');
  });

  it('簽署中兩態都是撤回，且需要確認', () => {
    for (const status of ['awaiting_tenant', 'awaiting_landlord'] as const) {
      const actions = detailActions(status, { mock: false });
      expect(actions.map((a) => a.key)).toEqual(['void']);
      expect(actions[0].confirm).toBeTruthy();
    }
  });

  it('已完成可下載已簽 PDF 與 Audit Trail File', () => {
    expect(detailActions('completed', { mock: false }).map((a) => a.key)).toEqual([
      'signed_pdf',
      'audit_trail',
    ]);
  });

  it('mock 模式的已完成沒有 Audit Trail File（沒有真實簽署任務）', () => {
    expect(detailActions('completed', { mock: true }).map((a) => a.key)).toEqual(['signed_pdf']);
  });

  it('已拒簽與已撤回都是複製為新草稿', () => {
    for (const status of ['declined', 'voided'] as const) {
      expect(detailActions(status, { mock: false }).map((a) => a.key)).toEqual(['copy']);
    }
  });

  it('六種狀態都有定義且只有撤回帶確認', () => {
    for (const status of CONTRACT_STATUSES) {
      const actions = detailActions(status, { mock: false });
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(Boolean(action.confirm)).toBe(action.key === 'void');
      }
    }
  });
});

describe('contractEventTypeLabel', () => {
  it('七種里程碑事件都有中文標籤', () => {
    for (const type of CONTRACT_EVENT_TYPES) {
      const label = contractEventTypeLabel(type);
      expect(label).toBeTruthy();
      expect(label).not.toBe(type);
    }
  });

  it('個別型別對照正確', () => {
    expect(contractEventTypeLabel('created')).toBe('建立合約');
    expect(contractEventTypeLabel('tenant_signed')).toBe('乙方簽署');
    expect(contractEventTypeLabel('copied')).toBe('被複製為新草稿');
  });

  it('未知型別原樣回傳，不讓歷程整條消失', () => {
    expect(contractEventTypeLabel('未來新增的型別')).toBe('未來新增的型別');
  });
});

describe('contractEventEntries', () => {
  it('帶出中文型別、行為者標籤與附註', () => {
    const entries = contractEventEntries([
      makeEvent({ id: 1, type: 'created', actor: 'landlord' }),
      makeEvent({ id: 2, type: 'declined', actor: 'tenant', note: '租金太高', created_at: '2026-01-02 15:30:00' }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ key: 1, label: '建立合約', actorLabel: '房東', note: null });
    expect(entries[1]).toMatchObject({ label: '拒簽', actorLabel: '租客', note: '租金太高', color: 'red' });
    expect(entries[1].time).toBe('2026-01-02 15:30');
  });

  it('時間不可解析時原樣顯示', () => {
    const entries = contractEventEntries([makeEvent({ id: 1, created_at: '待補' })]);
    expect(entries[0].time).toBe('待補');
  });

  it('未知行為者原樣回傳', () => {
    const entries = contractEventEntries([
      makeEvent({ id: 1, actor: 'agent' as ContractEvent['actor'] }),
    ]);
    expect(entries[0].actorLabel).toBe('agent');
  });
});

describe('contractFileRows', () => {
  it('未完成的合約兩份文件都尚未產生', () => {
    const rows = contractFileRows(makeContract({ status: 'awaiting_tenant' }), [], { mock: false });
    expect(rows.map((r) => r.kind)).toEqual(['signed_pdf', 'audit_trail']);
    expect(rows.every((r) => r.state === 'pending')).toBe(true);
  });

  it('已保存的檔案可下載', () => {
    const rows = contractFileRows(
      makeContract({ status: 'completed' }),
      [makeFile({ kind: 'signed_pdf' })],
      { mock: false }
    );
    expect(rows[0]).toMatchObject({ state: 'saved', downloadHref: '/api/contracts/1/signed-pdf' });
    expect(rows[0].file?.byte_size).toBe(1024);
    // 完成但還沒抓到的仍算尚未產生
    expect(rows[1].state).toBe('pending');
  });

  it('保存失敗帶出錯誤訊息供補抓', () => {
    const rows = contractFileRows(
      makeContract({ status: 'completed' }),
      [makeFile({ kind: 'audit_trail', status: 'failed', rel_path: null, error: '下載連結回應 500' })],
      { mock: false }
    );
    expect(rows[1]).toMatchObject({ state: 'failed', error: '下載連結回應 500' });
    expect(rows[1].downloadHref).toBe('/api/contracts/1/audit-trail');
  });

  it('mock 模式沒有 Audit Trail File', () => {
    const rows = contractFileRows(makeContract({ status: 'completed' }), [], { mock: true });
    expect(rows[1].state).toBe('unavailable');
    expect(rows[1].hint).toContain('mock');
  });
});

describe('contractChainNodes', () => {
  it('沒有前身也沒有後繼時回空陣列', () => {
    const nodes = contractChainNodes(makeContract(), { derived_from: null, derived_contracts: [] });
    expect(nodes).toEqual([]);
  });

  it('relations 還沒載入時回空陣列', () => {
    expect(contractChainNodes(makeContract(), null)).toEqual([]);
  });

  it('前身 → 本約 → 後繼依序排列', () => {
    const nodes = contractChainNodes(makeContract({ id: 7, derived_from: 3 }), {
      derived_from: { id: 3, status: 'voided' },
      derived_contracts: [
        { id: 9, status: 'draft' },
        { id: 11, status: 'awaiting_tenant' },
      ],
    });
    expect(nodes.map((n) => [n.role, n.id])).toEqual([
      ['predecessor', 3],
      ['self', 7],
      ['successor', 9],
      ['successor', 11],
    ]);
    expect(nodes[0].status).toBe('voided');
    expect(nodes[1].href).toBeNull();
    expect(nodes[2].href).toBe('/contracts/9');
  });

  it('只有後繼時本約仍在鏈上', () => {
    const nodes = contractChainNodes(makeContract({ id: 2, status: 'voided' }), {
      derived_from: null,
      derived_contracts: [{ id: 5, status: 'draft' }],
    });
    expect(nodes.map((n) => n.role)).toEqual(['self', 'successor']);
  });
});
