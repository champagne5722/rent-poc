import { createFreeTsaProvider } from './freetsa-provider';
import { createMockAnchorProvider } from './mock-provider';
import type { AnchorProvider } from './provider';
import type { ProviderRegistry } from './verify-audit';

// 由環境變數決定錨定服務（MIL-88）。每次 job 執行時才呼叫，設定錯誤只讓這兩個 job 回 500，不影響其他 job。
//
// AUDIT_ANCHOR_PROVIDER：
//   freetsa  demo。RFC 3161，每個 IP 每秒 1 次，沒有 SLA（ADR-0019 決議 9）。
//   mock     本機開發。回執沒有簽章。NODE_ENV=production 時拒絕。
// 沒設定：非正式環境用 mock，正式環境丟錯。不退回 mock，免得稽核鏈看起來有錨定其實沒有。
//
// pilot 前換 TWCA 或中華電信：加一個 `createFreeTsaProvider({ id: 'twca', url, trustedRootsPem })` 的分支。
// 驗證用的登錄表要保留 freetsa：已存的 demo 回執仍需驗證。

export interface AnchorProviders {
  /** anchor-audit 用的服務。 */
  primary: AnchorProvider;
  /** verify-audit 用的登錄表，以服務商 id 為鍵。 */
  byId: ProviderRegistry;
}

export function anchorProvidersFromEnv(
  env: Record<string, string | undefined> = process.env,
  now: () => Date = () => new Date(),
): AnchorProviders {
  const production = env.NODE_ENV === 'production';
  const name = env.AUDIT_ANCHOR_PROVIDER?.trim() || (production ? '' : 'mock');
  if (!name) throw new Error('正式環境必須設定 AUDIT_ANCHOR_PROVIDER（freetsa）');

  const freetsa = createFreeTsaProvider();
  switch (name) {
    case 'freetsa':
      return { primary: freetsa, byId: { freetsa } };
    case 'mock': {
      if (production) throw new Error('正式環境不得使用 mock 錨定服務：它的回執沒有簽章');
      const mock = createMockAnchorProvider({ now });
      return { primary: mock, byId: { mock, freetsa } };
    }
    default:
      throw new Error(`不認得的 AUDIT_ANCHOR_PROVIDER：${name}`);
  }
}
