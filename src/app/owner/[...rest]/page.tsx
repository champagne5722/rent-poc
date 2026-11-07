// /owner 底下不存在的路徑：AppShell 不套後台殼層，所以要在屋主端 layout 內顯示 404，
// 否則畫面會兩邊殼層都沒有。notFound() 交給同層的 owner/not-found.tsx。
import { notFound } from 'next/navigation';

export default function OwnerUnknownPage() {
  notFound();
}
