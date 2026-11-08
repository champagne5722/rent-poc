import { createHash } from 'node:crypto';
import type { OrgTx } from '../pg/with-tx';
import { isAuditAction } from './actions';

// 本地鏈驗證（ADR-0019 決議 13，MIL-82）。外部錨定的比對由 MIL-88 接上，這裡不碰。
//
// 介面的規則：
// - 必須在組織脈絡內執行（org 或 operator 脈絡）。驗證的是 app.org_id 那一條鏈，RLS 讓它只讀得到自己的列。
//   平台組織的鏈用平台組織的 ID 開 org 脈絡驗證。
// - 對存下來的位元組重算：hash = sha256(prev_hash || canonical)。不重新序列化 canonical。
// - 同時比對各欄位與 canonical 的內容，所以只改欄位、不改 canonical 也抓得到。
// - 每次讀整條鏈。事件量變大時要改成從上次驗證點開始（ADR-0019 Consequences）。
// - 擋不住的事：有寫入權限的人重算整條鏈與鏈頭，本地驗證會通過。只有外部回執抓得到（MIL-88）。

const GENESIS_HASH = '0'.repeat(64);

export type ChainIssueKind =
  | 'seq_gap' // 序號不連續：中間少了事件，或從 1 以外的數字開始
  | 'prev_hash_mismatch' // prev_hash 不等於上一筆的 hash：斷鏈
  | 'hash_mismatch' // hash 不等於 sha256(prev_hash || canonical)：canonical 被改而沒有重算
  | 'canonical_invalid' // canonical 不是合法的 JSON 物件
  | 'canonical_mismatch' // 欄位與 canonical 的內容不同：只改了欄位
  | 'unknown_action' // 動作不在 AUDIT_ACTIONS 清單內
  | 'head_mismatch'; // 鏈頭與最後一筆事件不同：尾端被刪或鏈頭被改

export interface ChainIssue {
  kind: ChainIssueKind;
  /** 出問題的事件序號。鏈頭的問題沒有序號。 */
  seq: number | null;
  detail: string;
}

export interface ChainReport {
  ok: boolean;
  chainId: string;
  /** 讀到的事件筆數。 */
  count: number;
  /** 最後一筆的 hash，沒有事件時是 64 個 0。 */
  headHash: string;
  issues: ChainIssue[];
}

interface EventRow {
  chain_id: string;
  seq: string;
  at: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  object_type: string | null;
  object_id: string | null;
  payload: unknown;
  prev_hash: string;
  hash: string;
  canonical: string;
}

interface HeadRow {
  seq: string;
  hash: string;
}

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 鍵排序後序列化，只用來比較兩個 JSON 值是否相同，不產生任何要存下來的位元組。 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 拆欄與 canonical 內容不同的欄位名稱。 */
function differingFields(row: EventRow, c: Record<string, unknown>): string[] {
  const actor = isObject(c.actor) ? c.actor : {};
  const object = isObject(c.object) ? c.object : {};
  const checks: Array<[string, unknown, unknown]> = [
    ['v', c.v, 1],
    ['chain', c.chain, row.chain_id],
    ['seq', c.seq, Number(row.seq)],
    ['at', c.at, row.at],
    ['actor.type', actor.type, row.actor_type],
    ['actor.id', actor.id ?? null, row.actor_id],
    ['action', c.action, row.action],
    ['object.type', object.type ?? null, row.object_type],
    ['object.id', object.id ?? null, row.object_id],
  ];
  const bad = checks.filter(([, a, b]) => a !== b).map(([name]) => name);
  if (stable(c.payload) !== stable(row.payload)) bad.push('payload');
  return bad;
}

export async function verifyChain(tx: OrgTx): Promise<ChainReport> {
  const org = (await tx.query<{ org: string | null }>(`SELECT nullif(current_setting('app.org_id', true), '') AS org`)).rows[0]
    .org;
  if (!org) throw new Error('verifyChain 必須在組織脈絡內執行（org 或 operator 脈絡）');

  // 時間在資料庫端轉成 UTC 文字，與 session 時區無關
  const { rows } = await tx.query<EventRow>(
    `SELECT e.chain_id, e.seq::text AS seq,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
            actor_type, actor_id, action, object_type, object_id, payload, prev_hash, hash, canonical
       FROM audit.events e ORDER BY e.seq`, // e.seq：不加前綴的 seq 會指到輸出欄位（文字），排序變成 1、10、11、2
  );
  const head = (await tx.query<HeadRow>(`SELECT seq::text AS seq, hash FROM audit.chain_head()`)).rows[0];

  const issues: ChainIssue[] = [];
  const add = (kind: ChainIssueKind, seq: number | null, detail: string) => issues.push({ kind, seq, detail });

  let expectedSeq = 1;
  let expectedPrev = GENESIS_HASH;
  for (const row of rows) {
    const seq = Number(row.seq);
    if (seq !== expectedSeq) add('seq_gap', seq, `預期序號 ${expectedSeq}，實際 ${seq}`);
    if (row.prev_hash !== expectedPrev) add('prev_hash_mismatch', seq, 'prev_hash 不等於上一筆的 hash');
    if (sha256Hex(row.prev_hash + row.canonical) !== row.hash) {
      add('hash_mismatch', seq, 'hash 與 sha256(prev_hash || canonical) 不符');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.canonical);
    } catch {
      parsed = undefined;
    }
    if (!isObject(parsed)) {
      add('canonical_invalid', seq, 'canonical 不是合法的 JSON 物件');
    } else {
      const fields = differingFields(row, parsed);
      if (fields.length > 0) add('canonical_mismatch', seq, `欄位與 canonical 不同：${fields.join('、')}`);
    }
    if (!isAuditAction(row.action)) add('unknown_action', seq, `動作 ${row.action} 不在 AUDIT_ACTIONS 清單內`);

    // 用存下來的 hash 往下接，一處被改只會回報一處，不會讓後面每一筆都報錯
    expectedSeq = seq + 1;
    expectedPrev = row.hash;
  }

  const last = rows.at(-1);
  const lastSeq = last ? Number(last.seq) : 0;
  const lastHash = last ? last.hash : GENESIS_HASH;
  if (head) {
    if (Number(head.seq) !== lastSeq || head.hash !== lastHash) {
      add('head_mismatch', null, `鏈頭是 ${head.seq} 號，事件表最後一筆是 ${lastSeq} 號，或兩者的 hash 不同`);
    }
  } else if (lastSeq > 0) {
    add('head_mismatch', null, '有事件但沒有鏈頭');
  }

  return { ok: issues.length === 0, chainId: org, count: rows.length, headHash: lastHash, issues };
}
