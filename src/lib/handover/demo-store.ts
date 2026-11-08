// 畫面用的移交 store。接線票（MIL-105）把這裡換成 PostgreSQL adapter，頁面與 actions 不動。
// 記憶體資料掛在 globalThis，dev server 熱更新時不會重置。
import { demoHandoverSeed } from './demo-seed';
import { createMemoryHandoverStore } from './memory-store';
import type { HandoverStore } from './store';

const KEY = Symbol.for('rentpoc.handoverStore');

type GlobalWithStore = typeof globalThis & { [KEY]?: HandoverStore };

export function handoverStore(): HandoverStore {
  const g = globalThis as GlobalWithStore;
  g[KEY] ??= createMemoryHandoverStore(demoHandoverSeed());
  return g[KEY];
}
