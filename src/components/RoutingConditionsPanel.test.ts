import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BrokerChoice } from '@/lib/practitioner-assignment/broker-choice';
import { brokerChoiceOf, BROKERAGE_BLOCKED_REASON } from '@/lib/practitioner-assignment/broker-choice';
import { DEFAULT_ROUTING } from '@/lib/signature-routing';
import RoutingConditionsPanel from './RoutingConditionsPanel';

// 建約精靈第一步的居間選項（MIL-200、MIL-209）：三種組織情況各自的顯示。
// 狀態由伺服端的 brokerChoiceOf 算出，精靈把它原樣傳給分流條件區，這裡把兩段接起來驗證。

const BROKER_LABEL = '是否有經紀業者居間';

function render(brokerChoice: BrokerChoice, brokerMediated = false): string {
  return renderToStaticMarkup(
    createElement(RoutingConditionsPanel, {
      value: { ...DEFAULT_ROUTING, brokerMediated },
      onChange: () => undefined,
      brokerChoice,
      caseDerived: true,
    }),
  );
}

describe('分流條件區的居間選項', () => {
  it('屋主組織：不顯示居間選項，也沒有提示', () => {
    const html = render(brokerChoiceOf('owner', null));
    expect(html).not.toContain(BROKER_LABEL);
    expect(html).not.toContain(BROKERAGE_BLOCKED_REASON);
  });

  it('業者組織沒有登錄經紀業別：不顯示', () => {
    const html = render(brokerChoiceOf('practice', null));
    expect(html).not.toContain(BROKER_LABEL);
    expect(html).not.toContain(BROKERAGE_BLOCKED_REASON);
  });

  it('業者組織的經紀業別登錄了但還沒驗證：顯示成不能選，旁邊寫原因', () => {
    const html = render(brokerChoiceOf('practice', 'registered'));
    expect(html).toContain(BROKER_LABEL);
    expect(html).toContain(BROKERAGE_BLOCKED_REASON);
    const inputs = html.split('<input').slice(1).filter((input) => input.includes('type="radio"'));
    // 最後兩個單選鈕是居間的「是」與「否」
    const brokerInputs = inputs.slice(-2);
    expect(brokerInputs).toHaveLength(2);
    expect(brokerInputs.every((input) => input.includes('disabled'))).toBe(true);
  });

  it('業者組織的經紀業別已驗證：能勾選', () => {
    const html = render(brokerChoiceOf('practice', 'verified'));
    expect(html).toContain(BROKER_LABEL);
    expect(html).not.toContain(BROKERAGE_BLOCKED_REASON);
    const brokerInputs = html.split('<input').slice(1).filter((input) => input.includes('type="radio"')).slice(-2);
    expect(brokerInputs).toHaveLength(2);
    expect(brokerInputs.some((input) => input.includes('disabled'))).toBe(false);
  });
});
