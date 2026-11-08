// 事件類型登錄（ADR-0050 決議 3）。
// 其他線新增事件時，只呼叫 `defineLedgerEvent()` 寫事件定義與分錄模板，再放進登錄表。
// 核心函式（buildJournal、validateJournal、buildReversal）不認識任何事件類型，所以不必改。

import type { JournalLine } from './types';

export type ParseResult<P> = { ok: true; value: P } | { ok: false; errors: string[] };

export interface TemplateContext {
  /** 分錄所屬的案件 ID。科目編碼裡的 `{case}` 用這個。 */
  caseId: string;
}

export interface LedgerEventDefinition<P> {
  /** 事件類型，小寫英文加底線，例如 `deposit_deducted`。 */
  readonly type: string;
  /** 繁體中文名稱，給畫面與錯誤訊息用。 */
  readonly label: string;
  /** false 表示不得經 `buildJournal` 直接寫入，只能由專用建構函式產生（例如 `reversal`）。 */
  readonly postable: boolean;
  /** 把外部輸入轉成型別明確的 payload。不合法時回傳中文錯誤訊息清單。 */
  parsePayload(raw: unknown): ParseResult<P>;
  /** 分錄模板：由 payload 產生借貸明細。明細列數與科目不限，平衡由 `validateJournal` 檢查。 */
  template(payload: P, ctx: TemplateContext): JournalLine[];
}

/** 登錄表裡存放的形式。payload 型別在這裡被抹除，由 `parsePayload` 在執行時把關。 */
export type AnyLedgerEvent = LedgerEventDefinition<unknown>;

export interface DefineLedgerEventInput<P> {
  type: string;
  label: string;
  postable?: boolean;
  parsePayload(raw: unknown): ParseResult<P>;
  template(payload: P, ctx: TemplateContext): JournalLine[];
}

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** 定義一個事件。型別字串不合法時丟錯，因為這是程式寫錯，不是執行時的輸入問題。 */
export function defineLedgerEvent<P>(input: DefineLedgerEventInput<P>): LedgerEventDefinition<P> {
  if (!EVENT_TYPE_PATTERN.test(input.type)) {
    throw new RangeError(`事件類型不合法：${JSON.stringify(input.type)}`);
  }
  return Object.freeze({
    type: input.type,
    label: input.label,
    postable: input.postable ?? true,
    parsePayload: input.parsePayload,
    template: input.template,
  });
}

export interface LedgerRegistry {
  get(type: string): AnyLedgerEvent | undefined;
  types(): string[];
}

/** 建立登錄表。事件類型重複時丟錯。登錄表建好後不可變。 */
export function createLedgerRegistry(definitions: readonly AnyLedgerEvent[]): LedgerRegistry {
  const byType = new Map<string, AnyLedgerEvent>();
  for (const definition of definitions) {
    if (byType.has(definition.type)) {
      throw new RangeError(`事件類型重複登錄：${definition.type}`);
    }
    byType.set(definition.type, definition);
  }
  return {
    get: (type) => byType.get(type),
    types: () => [...byType.keys()],
  };
}

/** 在既有登錄表上加事件，回傳新的登錄表。其他線用這個加自己的事件。 */
export function extendLedgerRegistry(
  base: LedgerRegistry,
  definitions: readonly AnyLedgerEvent[],
): LedgerRegistry {
  const existing = base.types().map((type) => base.get(type) as AnyLedgerEvent);
  return createLedgerRegistry([...existing, ...definitions]);
}
