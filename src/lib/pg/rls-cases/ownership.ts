// 所有權節點、謄本送件與文件核對（MIL-201，ADR-0026 決議 1、2、6 到 9，ADR-0028 決議 3、4）。
// 兩張組織表都只增不改（app_rw 只有 SELECT 與 INSERT）：狀態轉移與補件由定義者函式執行。
// 三個 registry 函式的政策說明（誰能呼叫、回什麼、為什麼）在 migration 0079 的註解與 Linear MIL-201 的留言。
import { newUlid } from '../ulid';
import type { OrgTx } from '../with-tx';
import type { DefinerOnlyTable, OrgTableCase, RegistryFunctionCase, RegistryTableCase, RlsRegistration } from './types';

/** 在目前組織建物件（待驗證錨點與 0000 單位），回傳錨點 ID。 */
async function seedAnchor(tx: OrgTx, orgId: string): Promise<string> {
  const anchorId = newUlid();
  const unitId = newUlid();
  await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [anchorId, unitId, '滲透測試地址']);
  await tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [
    newUlid(),
    orgId,
    unitId,
    '滲透測試物件',
    '滲透測試地址',
  ]);
  return anchorId;
}

async function seedNode(tx: OrgTx, orgId: string): Promise<string> {
  const anchorId = await seedAnchor(tx, orgId);
  const id = newUlid();
  await tx.query('INSERT INTO org.ownership_nodes (id, org_id, anchor_id) VALUES ($1, $2, $3)', [id, orgId, anchorId]);
  return id;
}

const orgTables: Record<string, OrgTableCase> = {
  'org.ownership_nodes': {
    appendOnly: true,
    seed: seedNode,
  },
  'org.ownership_submissions': {
    appendOnly: true,
    async seed(tx, orgId) {
      const nodeId = await seedNode(tx, orgId);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.ownership_submissions
           (id, org_id, node_id, seq, claimed_owner_name, acquired_at, city_code, town_code, section_code, building_no, sub_no,
            object_key, sha256, byte_size, content_type, file_name, uploaded_by)
         VALUES ($1, $2, $3, 1, '滲透測試所有權人', now(), 'A', '02', '0021', '00001', '000',
                 $4, repeat('a', 64), 1, 'application/pdf', 'penetration.pdf', $5)`,
        [id, orgId, nodeId, `org/${orgId}/transcripts/${id}.pdf`, newUlid()],
      );
      return id;
    },
  },
};

const registryTables: Record<string, RegistryTableCase> = {
  'registry.ownership_decisions': {
    purpose: '營運者每次核對的判定紀錄：兩項比對、判定人、時間與理由，只增不改。登錄的一方讀不到（MIL-201）',
  },
  'registry.verified_ownership_keys': {
    purpose:
      '已驗證的所有權節點的鍵。判定函式用它查「別的組織對同一個鍵是否已有已驗證的節點」，不穿過組織 RLS（MIL-201）。同一個鍵只能有一列，除非營運者決定並存（coexist_conflict_id，MIL-208）',
  },
  'registry.ownership_conflicts': {
    purpose: '兩方都通過核對時的衝突個案：後來的一方與先前的一方的節點、鍵、營運者的決定。已決定的個案不再改（MIL-208）',
  },
  'registry.ownership_contacts': {
    purpose: '營運者個別聯絡衝突雙方的紀錄：對象、時間、管道、結果。只增不改，結果文字只存在這裡（MIL-208）',
  },
};

const OPERATOR_ONLY = '營運者專用，先確認 app.operator_id 是平台組織的成員，組織成員與其他脈絡呼叫會被拒（MIL-201）';

const registryFunctions: Record<string, RegistryFunctionCase> = {
  'registry.submit_ownership_transcript': {
    probe: (tx, { anchorId }) =>
      tx.query(
        `SELECT * FROM registry.submit_ownership_transcript($1, $2, $3, $4, '探測', now() - interval '1 day', false, NULL, NULL, NULL, NULL, $5, repeat('a', 64), 1, 'application/pdf', 'probe.pdf')`,
        [anchorId, newUlid(), newUlid(), newUlid(), 'org/probe/probe.pdf'],
      ),
    reason: '以物件 ID 送出謄本，呼叫者組織沒有營運資料指向該物件就失敗，與物件不存在的錯誤相同（P0002）',
    disclosure: {
      kind: 'none',
      reason:
        '寫入函式。回傳結果代碼、呼叫者自己組織的節點與送件 ID、節點狀態。鍵有沒有與別的組織重複，函式不讀也不回。不含執業人員資料',
    },
  },
  'registry.decide_ownership_check': {
    probe: null,
    reason: OPERATOR_ONLY,
    disclosure: {
      kind: 'none',
      reason:
        '營運者專用的寫入函式。判定人取自交易脈絡。回傳結果代碼與登錄方自己的節點與物件 ID，不含別的組織的任何資料。有衝突時只回 held，原因只記在營運者讀的項目',
    },
  },
  'registry.ownership_review_item': {
    probe: null,
    reason: OPERATOR_ONLY,
    disclosure: {
      kind: 'none',
      reason: '營運者專用。回登錄方組織名稱與送件當下的鍵、段名，不含證號、統編、email、執業人員資料與所有權人姓名',
    },
  },
};

const PLATFORM_ONLY =
  '營運者專用，先確認 app.operator_id 是平台組織的成員且 app.org_id 是平台組織，組織成員與其他脈絡呼叫會被拒（MIL-208）';

const conflictFunctions: Record<string, RegistryFunctionCase> = {
  'registry.precheck_ownership_conflict': {
    probe: null,
    reason: PLATFORM_ONLY,
    disclosure: {
      kind: 'none',
      reason: '營運者專用。只回 held 或 clear，不含任何組織的資料。偵測在平台脈絡完成，所以後來的一方的組織不會多一筆存取事件',
    },
  },
  'registry.ownership_conflict_detail': {
    probe: null,
    reason: PLATFORM_ONLY,
    disclosure: {
      kind: 'none',
      reason:
        '營運者專用。回雙方的組織名稱與 ID、節點與送件 ID、遮罩的登記名義人、鍵與聯絡紀錄。不含主張的所有權人、信託資料、檔案 key 與 SHA-256，不讀組織表',
    },
  },
  'registry.record_ownership_contact': {
    probe: null,
    reason: PLATFORM_ONLY,
    disclosure: {
      kind: 'none',
      reason: '營運者專用的寫入函式。記錄人取自交易脈絡。回結果代碼與聯絡編號。平台鏈的事件不放結果文字',
    },
  },
  'registry.decide_ownership_conflict': {
    probe: null,
    reason: OPERATOR_ONLY,
    disclosure: {
      kind: 'none',
      reason:
        '營運者專用的寫入函式，在後來的一方的 operator 脈絡內執行。回決定與進行中的案件數。寫給雙方的通知與稽核事件不含另一方的任何資料',
    },
  },
};

const definerOnlyTables: Record<string, DefinerOnlyTable> = {
  'registry.ownership_decisions': {
    reason: '判定紀錄（MIL-201）。只經 registry.decide_ownership_check 寫入，觸發器擋 UPDATE、DELETE、TRUNCATE，app_rw 沒有任何權限',
  },
  'registry.verified_ownership_keys': {
    reason: '已驗證節點的鍵（MIL-201）。只經 registry.decide_ownership_check 與 decide_ownership_conflict 寫入與讀取，app_rw 沒有任何權限',
  },
  'registry.ownership_conflicts': {
    reason: '衝突個案（MIL-208）。只經 precheck_ownership_conflict、decide_ownership_check、decide_ownership_conflict 寫入，經 ownership_conflict_detail 讀取，app_rw 沒有任何權限',
  },
  'registry.ownership_contacts': {
    reason: '聯絡紀錄（MIL-208）。只經 record_ownership_contact 寫入，經 ownership_conflict_detail 讀取，觸發器擋 UPDATE、DELETE、TRUNCATE，app_rw 沒有任何權限',
  },
};

export const ownershipRls: RlsRegistration = {
  orgTables,
  registryTables,
  registryFunctions: { ...registryFunctions, ...conflictFunctions },
  definerOnlyTables,
};
