import { verifySignersEnabled } from '../dottedsign';
import { REGISTRY_UNAVAILABLE_REASON } from '../send-preconditions';
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

export type PracticeRegistryResolution =
  | { available: true; registry: PracticeRegistry }
  | { available: false; reason: string };

export { REGISTRY_UNAVAILABLE_REASON };

/**
 * 依環境選 adapter（ADR-0021 決議 3、後果）。
 * - 有真實 adapter（C 線 MIL-113）：任何環境都用它。
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

// C 線的真實 adapter 在啟動時註冊。D 線不註冊，所以預設永遠是 seed 或不可用。
let liveRegistry: PracticeRegistry | null = null;

export function registerLivePracticeRegistry(registry: PracticeRegistry | null): void {
  liveRegistry = registry;
}

/** route handler 的入口。 */
export function getPracticeRegistry(env: Record<string, string | undefined> = process.env): PracticeRegistryResolution {
  return resolvePracticeRegistry({ env, live: liveRegistry });
}
