import ListPageSkeleton from '@/components/page/ListPageSkeleton';

// 收款帳戶載入中：顯示骨架畫面，不整頁轉圈（MIL-181）。
export default function Loading() {
  return <ListPageSkeleton />;
}
