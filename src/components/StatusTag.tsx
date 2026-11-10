import { Tag } from 'antd';
import { statusPresentation, toneTagColor, type StatusKind, type StatusValues } from '@/lib/status-presentation';

// 狀態標籤（MIL-172、ADR-0090）：讀 src/lib/status-presentation.ts 的狀態呈現表，同一個狀態全站同名同色。
// 只組合 antd 的 Tag，不覆寫外觀。顏色是 antd 的語意色，來源是 DESIGN.md 的 semantic-* 與 primary。
// 之後的頁面一律用這個元件顯示合約、案件、移交與審核台項目的狀態，不另寫顏色對照。

export interface StatusTagProps<K extends StatusKind> {
  kind: K;
  value: StatusValues[K];
}

export default function StatusTag<K extends StatusKind>({ kind, value }: StatusTagProps<K>) {
  const { label, tone } = statusPresentation(kind, value);
  return <Tag color={toneTagColor(tone)}>{label}</Tag>;
}
