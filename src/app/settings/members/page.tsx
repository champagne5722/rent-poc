import type { Metadata } from 'next';
import MembersPanel from '@/components/MembersPanel';

export const metadata: Metadata = { title: '成員管理｜租房雲端管理平台' };

// 組織成員管理（MIL-106）。登入閘門在根 layout，資料與權限由 /api/org/* 的 route 把關。
export default function MembersPage() {
  return <MembersPanel />;
}
