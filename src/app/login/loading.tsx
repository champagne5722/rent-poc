import { AuthPanelSkeleton } from '@/components/AuthPanel';

// 登入頁載入中：顯示骨架畫面，不整頁轉圈（MIL-183）。
export default function Loading() {
  return <AuthPanelSkeleton />;
}
