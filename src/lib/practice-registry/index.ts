import { verifySignersEnabled } from '../dottedsign';
import { REGISTRY_UNAVAILABLE_REASON } from '../send-preconditions';
import { createLivePracticeRegistry, type RegistryRunner } from './live-adapter';
import { requestOrgRunner } from './request-runner';
import { createSeedPracticeRegistry } from './seed-adapter';
import type { PracticeRegistry } from './types';

export type {
  PartySignerCandidate,
  PracticeEntity,
  PracticeRegistry,
  PractitionerCandidate,
  PractitionerQuery,
} from './types';
export { createSeedPracticeRegistry, SEED_ENTITIES, SEED_PARTY_SIGNERS } from './seed-adapter';
export { createLivePracticeRegistry, txRunner, type LiveRegistryOptions, type RegistryRunner } from './live-adapter';

export type PracticeRegistryResolution =
  | { available: true; registry: PracticeRegistry }
  | { available: false; reason: string };

export { REGISTRY_UNAVAILABLE_REASON };

/**
 * 依環境選 adapter（ADR-0021 決議 3、後果）。
 * - 有真實 adapter（MIL-113）：任何環境都用它。
 * - 沒有真實 adapter：mock 與 sandbox 用 seed 假資料。
 * - 正式金鑰且沒有真實 adapter：不可用，要求執業人員的組合必須擋下送簽。
 *
 * 正式金鑰的判定沿用 `DOTTEDSIGN_VERIFY_SIGNERS=1`（MIL-65），不從金鑰字串推斷。
 * 這個變數的意思是「送簽要帶簽署人驗證」，只有正式環境會設。
 */
export function resolvePracticeRegistry(options: {
  env: Record<string, string | undefined>;
  live?: PracticeRegistry | null;
  seed?: () => PracticeRegistry;
}): PracticeRegistryResolution {
  if (options.live) return { available: true, registry: options.live };
  if (verifySignersEnabled(options.env)) return { available: false, reason: REGISTRY_UNAVAILABLE_REASON };
  return { available: true, registry: (options.seed ?? createSeedPracticeRegistry)() };
}

// 明確指定的覆寫，給測試與特殊情境用。沒有覆寫時，`getPracticeRegistry` 在請求時建立真實 adapter。
let liveRegistry: PracticeRegistry | null = null;

export function registerLivePracticeRegistry(registry: PracticeRegistry | null): void {
  liveRegistry = registry;
}

/** 只有明確設成 seed 才用假資料（mock 示範與測試）。其他情況一律用真實 adapter。 */
export function seedRegistryRequested(env: Record<string, string | undefined>): boolean {
  return env.PRACTICE_REGISTRY === 'seed';
}

export interface GetPracticeRegistryOptions {
  /**
   * 真實 adapter 查登錄時開交易用的執行器。預設在目前請求的組織脈絡內開短交易。
   * 沒有請求脈絡的呼叫端（簽署 webhook）傳入自己的執行器。
   */
  run?: RegistryRunner;
}

/**
 * route handler 與訂閱者的入口。
 * - 有 `registerLivePracticeRegistry` 的覆寫：用它。
 * - `PRACTICE_REGISTRY=seed`：走 `resolvePracticeRegistry`（假資料；正式金鑰下不可用）。
 * - 其他：真實 adapter。每次呼叫建一個新的 adapter，請求脈絡由它的執行器解析。
 */
export function getPracticeRegistry(
  env: Record<string, string | undefined> = process.env,
  options: GetPracticeRegistryOptions = {},
): PracticeRegistryResolution {
  if (liveRegistry) return resolvePracticeRegistry({ env, live: liveRegistry });
  if (seedRegistryRequested(env)) return resolvePracticeRegistry({ env });
  return resolvePracticeRegistry({ env, live: createLivePracticeRegistry({ run: options.run ?? requestOrgRunner() }) });
}

export { requestOrgRunner };
