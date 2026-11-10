import { authorize, bindAccessContext, checkAccess, Forbidden } from './authorize';
import { listContracts } from './contracts';
import { listProperties } from './properties';
import { requestContext } from './current-request-context';
import { withTx } from './pg/database';
import { toDbContext } from './request-context';
import { buildSigningProgress } from './contract-list-load';
import type { SigningProgressById } from './signing-steps';
import type { Contract } from './types';

// 工作台的資料載入（MIL-178）。只用現有的合約、簽署進度與物件讀取，不新增查詢。
// 沒有物件讀取權限時，物件筆數為 null，工作台不顯示物件數字。

export type WorkbenchLoad =
  | { kind: 'ok'; contracts: Contract[]; progress: SigningProgressById; propertyCount: number | null }
  // 不是組織身分，或身分沒有查看合約的權限
  | { kind: 'forbidden' };

/** 沒登入時丟 Unauthenticated，由頁面導向登入。只給 server component 用。 */
export async function loadWorkbench(): Promise<WorkbenchLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'org') return { kind: 'forbidden' };
  let loaded: { contracts: Contract[]; propertyCount: number | null };
  try {
    loaded = await withTx(toDbContext(rc), async (tx) => {
      bindAccessContext(tx, rc);
      await authorize(tx, 'contract.read', { type: 'org' });
      const contracts = await listContracts(tx);
      const canReadProperties = (await checkAccess(tx, 'property.read', { type: 'org' })).allowed;
      const propertyCount = canReadProperties ? (await listProperties(tx)).length : null;
      return { contracts, propertyCount };
    });
  } catch (error) {
    if (error instanceof Forbidden) return { kind: 'forbidden' };
    throw error;
  }
  return { kind: 'ok', ...loaded, progress: await buildSigningProgress(loaded.contracts) };
}
