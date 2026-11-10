import type { Metadata } from 'next';
import PractitionerPanel from '@/components/PractitionerPanel';

export const metadata: Metadata = { title: '我的證書｜租房雲端管理平台' };

// 執業人員本人的證書登錄、任職與補件（MIL-111）。登入閘門在根 layout，資料與權限由 /api/practitioner/* 的 route 把關。
export default function PractitionerPage() {
  return <PractitionerPanel />;
}
