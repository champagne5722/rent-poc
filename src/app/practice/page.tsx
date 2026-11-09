import type { Metadata } from 'next';
import PracticePanel from '@/components/PracticePanel';

export const metadata: Metadata = { title: '執業主體｜租房雲端管理平台' };

// 執業主體的登錄進度與送件（MIL-109）。登入閘門在根 layout，資料與權限由 /api/practice/* 的 route 把關。
export default function PracticePage() {
  return <PracticePanel />;
}
