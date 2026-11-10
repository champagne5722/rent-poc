import { authorize, bindAccessContext, Forbidden } from './authorize';
import { listContracts } from './contracts';
import { listProperties } from './properties';
import { requestContext } from './current-request-context';
import { withTx } from './pg/database';
import { toDbContext } from './request-context';
import { contractSubject, signing, signingSubjectKey } from './signing-module';
import type { SigningProgressById } from './signing-steps';
import type { Contract } from './types';

// 合約列表的資料載入（MIL-174）。列表頁在 server component 呼叫它，GET /api/contracts 共用同一份簽署進度組裝。
// 清單與工作台共用。簽署進度一次批次查回整頁合約，以合約編號為鍵（MIL-72）。
// 沒有簽署任務的合約（草稿、沒有回填的舊合約）不在結果裡。清單只需要角色、姓名與狀態，不回簽署人的 email。

export async function buildSigningProgress(contracts: readonly Contract[]): Promise<SigningProgressById> {
  // 簽署進度另開組織交易批次查，不佔著清單的連線。查詢次數與合約數量無關
  const progress = await signing.getProgressBatch(contracts.map((c) => contractSubject(c.id)));
  const result: Record<string, NonNullable<SigningProgressById[string]>> = {};
  for (const c of contracts) {
    const entry = progress.get(signingSubjectKey(contractSubject(c.id)));
    if (!entry) continue;
    result[c.id] = {
      status: entry.status,
      signers: entry.signers.map(({ role, name, status, concurrentRoles }) => ({
        role,
        name,
        status,
        ...(concurrentRoles ? { concurrentRoles } : {}),
      })),
    };
  }
  return result;
}

export type ContractListLoad =
  | {
      kind: 'ok';
      contracts: Contract[];
      progress: SigningProgressById;
      // 物件 ID 到顯示編碼的對照（MIL-145）。沒有物件讀取權限或讀不到的物件不在裡面
      displayCodes: Record<string, string | null>;
    }
  // 不是組織身分，或身分沒有查看合約的權限
  | { kind: 'forbidden' };

/**
 * 載入目前組織的合約與簽署進度。沒登入時丟 Unauthenticated，由頁面導向登入。
 * 只給 server component 用；route handler 走 readInOrgTx，才能把拒絕轉成 401、403 的回應。
 */
export async function loadContractList(): Promise<ContractListLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'org') return { kind: 'forbidden' };
  let loaded: { contracts: Contract[]; displayCodes: Record<string, string | null> };
  try {
    loaded = await withTx(toDbContext(rc), async (tx) => {
      bindAccessContext(tx, rc);
      await authorize(tx, 'contract.read', { type: 'org' });
      const contracts = await listContracts(tx);
      // 顯示編碼是輔助資訊：沒有物件讀取權限時，列表照常顯示，編碼欄留空
      const displayCodes: Record<string, string | null> = {};
      try {
        await authorize(tx, 'property.read', { type: 'org' });
        for (const p of await listProperties(tx)) displayCodes[p.id] = p.unit?.display_code ?? null;
      } catch (error) {
        if (!(error instanceof Forbidden)) throw error;
      }
      return { contracts, displayCodes };
    });
  } catch (error) {
    if (error instanceof Forbidden) return { kind: 'forbidden' };
    throw error;
  }
  return { kind: 'ok', ...loaded, progress: await buildSigningProgress(loaded.contracts) };
}
