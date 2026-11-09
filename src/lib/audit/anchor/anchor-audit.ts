import type { WithTx } from '../../pg/with-tx';
import { consoleAuditLogger, type AuditLogger } from './audit-log';
import { buildMerkleTree } from './merkle';
import type { AnchorProvider } from './provider';
import { isSupersededError, listUnanchoredHeads, recordAnchor, recordAnchorFailure } from './store';

// anchor-audit：把各組織的鏈頭組成 Merkle 樹根，送到平台外服務，保存回執與葉（ADR-0019 決議 7、8、10，MIL-88）。
//
// 流程與交易邊界（withTx 規則 2：交易內不得呼叫外部服務）：
//   交易 1（control）讀未錨定的鏈頭 → 交易外建樹、呼叫服務 → 交易 2（control）保存批次、葉、證明。
//
// 規則：
// - 沒有未錨定的鏈頭（所有鏈都沒有新事件）時不呼叫外部服務，也不寫任何列。
// - 服務失敗時什麼都不保存。稽核寫入完全不依賴這個 job，所以寫入照常。未錨定的鏈頭留在原地，
//   下一次排程會連同失敗期間的新事件一起送出。
// - 失敗次數寫在資料庫，不放記憶體：每次排程是一個新的請求。連續 2 次以上寫 ERROR 等級 log。
// - 服務呼叫期間，同一個 job 可能被另一個排程再跑一次。後到的在保存時發現鏈頭已被涵蓋，回報 superseded。
// - 時間由呼叫端傳入，這裡不讀時鐘。

export interface AnchorAuditDeps {
  withTx: WithTx;
  provider: AnchorProvider;
  logger?: AuditLogger;
}

export type AnchorAuditOutcome =
  | { status: 'no_changes' }
  | { status: 'anchored'; batchId: number; chains: number; root: string; provider: string; issuedAt: string }
  | { status: 'superseded' }
  | { status: 'failed'; consecutiveFailures: number; provider: string; error: string };

/** 連續失敗幾次起寫 ERROR 等級 log（ADR-0019 決議 10）。 */
export const ANCHOR_ERROR_AFTER_FAILURES = 2;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runAnchorAudit(deps: AnchorAuditDeps, now: Date): Promise<AnchorAuditOutcome> {
  const { withTx, provider } = deps;
  const logger = deps.logger ?? consoleAuditLogger;

  const heads = await withTx({ kind: 'control' }, (tx) => listUnanchoredHeads(tx));
  if (heads.length === 0) return { status: 'no_changes' };

  const tree = buildMerkleTree(heads);

  let issue;
  try {
    issue = await provider.anchor(tree.root);
  } catch (e) {
    const error = messageOf(e);
    const consecutiveFailures = await withTx({ kind: 'control' }, (tx) => recordAnchorFailure(tx, now, error));
    const fields = { provider: provider.id, consecutiveFailures, chains: heads.length, error };
    if (consecutiveFailures >= ANCHOR_ERROR_AFTER_FAILURES) {
      logger.log('ERROR', `稽核鏈錨定連續失敗 ${consecutiveFailures} 次，未錨定的窗口持續擴大`, fields);
    } else {
      logger.log('WARNING', '稽核鏈錨定失敗，下一次排程會再送', fields);
    }
    return { status: 'failed', consecutiveFailures, provider: provider.id, error };
  }

  try {
    const batchId = await withTx({ kind: 'control' }, (tx) =>
      recordAnchor(tx, { at: now, provider: provider.id, root: tree.root, receipt: issue.receipt, issuedAt: issue.issuedAt, leaves: tree.leaves }),
    );
    return {
      status: 'anchored',
      batchId,
      chains: tree.leaves.length,
      root: tree.root,
      provider: provider.id,
      issuedAt: issue.issuedAt.toISOString(),
    };
  } catch (e) {
    if (isSupersededError(e)) return { status: 'superseded' };
    throw e; // 資料庫錯誤：回 500，下一次排程重做。回執沒有存下來，只是多花一次外部呼叫
  }
}
