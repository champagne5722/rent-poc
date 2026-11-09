import type { Metadata } from 'next';
import DeskQueue from '@/components/DeskQueue';

export const metadata: Metadata = { title: '審核台｜租房雲端管理平台' };

// 審核台佇列（MIL-109）。只有平台營運者身分能開啟，權限由 /api/desk/* 的 route 把關。
export default function DeskPage() {
  return <DeskQueue />;
}
