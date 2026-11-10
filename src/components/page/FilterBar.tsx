'use client';

import { Button, Flex, Segmented } from 'antd';
import type { ReactNode } from 'react';

// 篩選列（MIL-174、ADR-0090）：左側是狀態分段選單（每段帶筆數），右側放其他篩選控制項，有篩選時多一顆「清除篩選」。
// 只組合 antd 的 Segmented、Button 與 Flex。篩選的狀態由頁面持有，這裡只畫畫面。

export interface FilterStatusOption<V extends string> {
  value: V;
  label: string;
  /** 該狀態的筆數，顯示在標籤後面。 */
  count?: number;
}

export interface FilterBarProps<V extends string = string> {
  status?: {
    value: V;
    options: readonly FilterStatusOption<V>[];
    onChange: (value: V) => void;
  };
  /** 其他篩選控制項，例如 Select、DatePicker.RangePicker。 */
  children?: ReactNode;
  /** 目前有沒有任何篩選條件。為 true 時顯示「清除篩選」。 */
  active: boolean;
  onClear: () => void;
}

export default function FilterBar<V extends string = string>({ status, children, active, onClear }: FilterBarProps<V>) {
  return (
    <Flex justify="space-between" align="center" gap="middle" wrap="wrap">
      {status ? (
        <Segmented<V>
          value={status.value}
          onChange={status.onChange}
          options={status.options.map((o) => ({
            value: o.value,
            label: o.count === undefined ? o.label : `${o.label} ${o.count}`,
          }))}
        />
      ) : (
        <span />
      )}
      <Flex align="center" gap="small" wrap="wrap">
        {children}
        {active && (
          <Button type="link" onClick={onClear}>
            清除篩選
          </Button>
        )}
      </Flex>
    </Flex>
  );
}
