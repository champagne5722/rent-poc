import ListPageSkeleton from '@/components/page/ListPageSkeleton';

// 合約列表載入中：顯示骨架畫面，不整頁轉圈（MIL-174）。
export default function Loading() {
  return <ListPageSkeleton />;
}
