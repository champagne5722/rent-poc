// audit schema 的表（稽核鏈與錨定）。歸 audit_owner，FORCE RLS，UPDATE、DELETE、TRUNCATE 由觸發器擋下。
import type { AuditTable, RlsRegistration } from './types';

const auditTables: Record<string, AuditTable> = {
  'audit.events': {
    reason: '稽核事件，只增不改。app_rw 只能讀，org_read 政策依 app.org_id 篩選自己的鏈。寫入只經 audit.append()',
    appRw: ['SELECT'],
  },
  'audit.chain_heads': {
    reason: '每條鏈的鏈頭（序號與雜湊）。app_rw 沒有任何權限，讀取只經 audit.chain_head()，寫入只經 audit.append()',
    appRw: [],
  },
  'audit.anchor_batches': {
    reason: '錨定批次（樹根與回執）。app_rw 沒有任何權限，讀寫只經 audit.record_anchor() 與 audit.chain_anchors()',
    appRw: [],
  },
  'audit.anchor_leaves': {
    reason: '錨定的葉與 Merkle 證明。app_rw 沒有任何權限，讀寫只經 audit.record_anchor() 與 audit.chain_anchors()',
    appRw: [],
  },
  'audit.anchor_runs': {
    reason: '每次錨定嘗試的結果。app_rw 沒有任何權限，讀寫只經 audit.record_anchor() 與 audit.record_anchor_failure()',
    appRw: [],
  },
};

export const auditRls: RlsRegistration = { auditTables };
