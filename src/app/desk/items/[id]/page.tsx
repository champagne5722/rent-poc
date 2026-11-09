import type { Metadata } from 'next';
import DeskItemPanel from '@/components/DeskItemPanel';

export const metadata: Metadata = { title: '核對｜租房雲端管理平台' };

export default async function DeskItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DeskItemPanel itemId={id} />;
}
