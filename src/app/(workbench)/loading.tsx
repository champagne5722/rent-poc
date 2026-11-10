import ListPageSkeleton from '@/components/page/ListPageSkeleton';

// 工作台載入中：顯示骨架畫面，不整頁轉圈（MIL-178）。
export default function Loading() {
  return <ListPageSkeleton />;
}
