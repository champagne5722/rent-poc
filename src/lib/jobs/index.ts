import { anchorProvidersFromEnv } from '../audit/anchor/providers-from-env';
import { signing } from '../signing-module';
import { type JobRouteDeps } from './handler';
import { createJobs } from './jobs';
import { createGoogleKeySource, oidcConfigFromEnv } from './oidc';
import { timerRegistry } from './timers';

// route 用的正式接線：真實的簽署模組、正式的計時器註冊處、Google 金鑰來源。
// 驗證設定每次請求都讀環境變數，改設定不必重啟。

// dev 模式模組重載時，金鑰快取也跟著重建就好，不需要掛 globalThis
const keys = createGoogleKeySource();
const jobs = createJobs({ signing, timers: timerRegistry, audit: { providers: () => anchorProvidersFromEnv() } });

export function productionJobDeps(): JobRouteDeps {
  return { config: oidcConfigFromEnv(), keys, jobs };
}
