import type { OrgTx, WithTx } from '../../pg/with-tx';
import { verifyChain, type ChainReport } from '../verify';
import { consoleAuditLogger, type AuditLogger } from './audit-log';
import { verifyMerkleProof } from './merkle';
import type { AnchorProvider } from './provider';
import { listChainAnchors, listChainIds } from './store';

// verify-audit：逐組織重算稽核鏈，再比對已存的葉、證明與回執（ADR-0019 決議 13，P0-23 AC4，MIL-88）。
//
// 為什麼要比對回執：超級使用者重算整條鏈與鏈頭後，本地驗證（verifyChain）會通過，
// 只有錨定當時外部服務簽出的回執抓得到（ADR-0019 實測表最後一列）。
//
// 規則：
// - 逐組織開 org 交易（set_config app.org_id），RLS 讓它只讀得到自己的鏈與葉。不需要跨組織的讀取權限，
//   也不需要 operator 脈絡（那會對每個組織寫一筆營運者存取紀錄）。組織清單從 control 讀。
// - 每個組織三層檢查：本地鏈（verifyChain）、葉對得上現在的事件、證明推得回樹根且回執有效。
// - 一個組織的檢查丟錯（連線中斷等）不影響其他組織，計入 errors 並寫 ERROR log。
// - 任何一條鏈有問題就寫 CRITICAL（最高等級）log。job 仍回 200：問題是資料狀態，重試不會改變結果。
// - 同一批次的回執只驗一次：批次由多個組織共用，驗過的結果在這次執行內重用。
// - 驗證到的是「已錨定的部分」。錨定之後才寫的事件，要等下一次錨定才有回執（ADR-0019 Consequences）。

export type ProviderRegistry = Readonly<Record<string, AnchorProvider>>;

export type ChainAnchorIssueKind =
  | 'anchored_event_missing' // 被錨定的序號在事件表找不到：尾端被刪或鏈被截斷
  | 'anchored_hash_mismatch' // 同一序號的事件雜湊與錨定時不同：鏈被重算過
  | 'anchor_proof_invalid' // 葉與證明推不回樹根
  | 'anchor_provider_unknown' // 回執的服務商不在登錄表，無法驗證
  | 'anchor_receipt_invalid'; // 回執驗不過：簽章、雜湊或格式

export interface ChainAnchorIssue {
  kind: ChainAnchorIssueKind;
  batchId: number;
  seq: number;
  detail: string;
}

export interface ChainAnchorReport {
  chainId: string;
  /** 比對過幾片葉。 */
  anchorsChecked: number;
  issues: ChainAnchorIssue[];
}

type ReceiptVerdict = { ok: true } | { ok: false; kind: ChainAnchorIssueKind; detail: string };

async function currentChainId(tx: OrgTx): Promise<string> {
  const { rows } = await tx.query<{ org: string | null }>(`SELECT nullif(current_setting('app.org_id', true), '') AS org`);
  if (!rows[0].org) throw new Error('verifyChainAnchors 必須在組織脈絡內執行（org 或 operator 脈絡）');
  return rows[0].org;
}

/**
 * 比對這條鏈（app.org_id）已存的葉與回執。`receipts` 是跨鏈共用的快取，同一批次只驗一次。
 */
export async function verifyChainAnchors(
  tx: OrgTx,
  providers: ProviderRegistry,
  receipts: Map<string, Promise<ReceiptVerdict>> = new Map(),
): Promise<ChainAnchorReport> {
  const chainId = await currentChainId(tx);
  const anchors = await listChainAnchors(tx);
  const issues: ChainAnchorIssue[] = [];
  if (anchors.length === 0) return { chainId, anchorsChecked: 0, issues };

  // 事件雜湊一次讀完。RLS 保證只有這條鏈的列
  const { rows } = await tx.query<{ seq: string; hash: string }>(
    `SELECT e.seq::text AS seq, e.hash FROM audit.events e
      WHERE e.seq IN (SELECT jsonb_array_elements_text($1::jsonb)::bigint)`,
    [JSON.stringify(anchors.map((a) => a.seq))],
  );
  const hashAt = new Map(rows.map((r) => [Number(r.seq), r.hash]));

  for (const a of anchors) {
    const add = (kind: ChainAnchorIssueKind, detail: string) => issues.push({ kind, batchId: a.batchId, seq: a.seq, detail });

    const actual = hashAt.get(a.seq);
    if (actual === undefined) add('anchored_event_missing', `序號 ${a.seq} 的事件不存在，錨定批次 ${a.batchId}`);
    else if (actual !== a.headHash) add('anchored_hash_mismatch', `序號 ${a.seq} 的事件雜湊與錨定批次 ${a.batchId} 記錄的不同`);

    if (!verifyMerkleProof({ chainId, seq: a.seq, headHash: a.headHash }, a.proof, a.root)) {
      add('anchor_proof_invalid', `批次 ${a.batchId} 的證明推不回樹根`);
    }

    const key = `${a.batchId}`;
    let verdict = receipts.get(key);
    if (!verdict) {
      const provider = providers[a.provider];
      verdict = provider
        ? provider.verify(a.root, a.receipt).then(
            (v): ReceiptVerdict => (v.ok ? { ok: true } : { ok: false, kind: 'anchor_receipt_invalid', detail: `批次 ${a.batchId} 的回執無效：${v.reason}` }),
          )
        : Promise.resolve<ReceiptVerdict>({ ok: false, kind: 'anchor_provider_unknown', detail: `批次 ${a.batchId} 的服務商 ${a.provider} 不在登錄表` });
      receipts.set(key, verdict);
    }
    const result = await verdict;
    if (!result.ok) add(result.kind, result.detail);
  }
  return { chainId, anchorsChecked: anchors.length, issues };
}

export interface VerifyAuditDeps {
  withTx: WithTx;
  /** 驗證回執用的 adapter，以服務商 id 為鍵。 */
  providers: ProviderRegistry;
  logger?: AuditLogger;
}

export interface FailedChain {
  chainId: string;
  /** 本地鏈的問題，格式「種類@序號」。 */
  local: string[];
  /** 錨定比對的問題，格式「種類@序號」。 */
  anchors: string[];
}

export interface VerifyAuditResult {
  chains: number;
  ok: number;
  failed: FailedChain[];
  /** 檢查本身出錯的鏈數（連線中斷等）。這些鏈沒有結論。 */
  errors: number;
  anchorsChecked: number;
  checkedAt: string;
}

const label = (i: { kind: string; seq: number | null }) => `${i.kind}@${i.seq}`;

export async function runVerifyAudit(deps: VerifyAuditDeps, now: Date): Promise<VerifyAuditResult> {
  const { withTx, providers } = deps;
  const logger = deps.logger ?? consoleAuditLogger;
  const chainIds = await withTx({ kind: 'control' }, (tx) => listChainIds(tx));

  const receipts = new Map<string, Promise<ReceiptVerdict>>();
  const result: VerifyAuditResult = { chains: chainIds.length, ok: 0, failed: [], errors: 0, anchorsChecked: 0, checkedAt: now.toISOString() };

  for (const chainId of chainIds) {
    try {
      const { local, anchor } = await withTx({ kind: 'org', orgId: chainId }, async (tx) => ({
        local: (await verifyChain(tx)) as ChainReport,
        anchor: await verifyChainAnchors(tx, providers, receipts),
      }));
      result.anchorsChecked += anchor.anchorsChecked;
      if (local.ok && anchor.issues.length === 0) {
        result.ok++;
        continue;
      }
      const failed: FailedChain = { chainId, local: local.issues.map((i) => label(i)), anchors: anchor.issues.map(label) };
      result.failed.push(failed);
      logger.log('CRITICAL', '稽核鏈驗證失敗：鏈或錨定回執與目前的資料不符，視為資安事件', {
        chainId,
        localIssues: failed.local,
        anchorIssues: failed.anchors,
      });
    } catch (e) {
      result.errors++;
      logger.log('ERROR', '稽核鏈驗證沒有完成', { chainId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
