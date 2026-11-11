// 把示範移交複製給目前登入的屋主（MIL-185）。
// 移交的資料還在記憶體 adapter，資料綁在虛構屋主的 ID，真實登入的屋主看不到任何移交（MIL-105 接線前）。
// 這個函式讓畫面截圖與流程測試能替真實屋主建立一筆移交。純函式，不讀寫 store。
import { demoHandoverSeed } from './demo-seed';
import type { HandoverRecord } from './store';

export const DEMO_HANDOVER_VARIANTS = ['draft', 'owner_confirmed', 'completed'] as const;
export type DemoHandoverVariant = (typeof DEMO_HANDOVER_VARIANTS)[number];

/** 各種狀態取自哪一筆示範移交。草稿從已確認的那筆倒退回去。 */
const SOURCE_ID: Record<DemoHandoverVariant, string> = {
  draft: 'ho-0004',
  owner_confirmed: 'ho-0004',
  completed: 'ho-0005',
};

export function isDemoHandoverVariant(value: unknown): value is DemoHandoverVariant {
  return typeof value === 'string' && (DEMO_HANDOVER_VARIANTS as readonly string[]).includes(value);
}

/** 複製一筆示範移交，換成指定的屋主與新 ID。找不到來源回 null。 */
export function cloneDemoHandover(variant: DemoHandoverVariant, ownerPartyId: string, id: string): HandoverRecord | null {
  const source = demoHandoverSeed().handovers.find((h) => h.id === SOURCE_ID[variant]);
  if (!source) return null;
  const record: HandoverRecord = { ...structuredClone(source), id, ownerPartyId };
  if (variant === 'draft') {
    return {
      ...record,
      state: 'draft',
      acknowledgedMissing: [],
      manual: { keyHandover: '', accessCardHandover: '', committeeContact: '' },
      events: record.events.slice(0, 1),
    };
  }
  return record;
}
