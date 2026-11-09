// route 用的執行器：每次查詢在目前請求的組織脈絡內開一個短交易（MIL-113）。
// 請求脈絡在一個執行器的生命週期內只解析一次，這樣一次送簽前檢查的十幾次登錄查詢不會各查一次 session。
// 動態 import：practice-registry 的其他檔案在沒有 Next.js 的環境（單元測試）也要能載入。

import type { OrgTx } from '../pg/with-tx';
import type { RegistryRunner } from './live-adapter';

export function requestOrgRunner(): RegistryRunner {
  let context: Promise<import('../request-context').RequestContext> | null = null;
  return async <R>(fn: (tx: OrgTx) => Promise<R>): Promise<R> => {
    const [{ requestContext }, { withTx }, { toDbContext }] = await Promise.all([
      import('../current-request-context'),
      import('../pg/database'),
      import('../request-context'),
    ]);
    context ??= requestContext();
    const rc = await context;
    if (rc.kind !== 'org') throw new Error('登錄查詢必須在組織身分內進行');
    return withTx(toDbContext(rc), (tx) => fn(tx));
  };
}
