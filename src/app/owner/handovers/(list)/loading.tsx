import ListPageSkeleton from '@/components/page/ListPageSkeleton';

// 屋主端移交列表載入中：顯示骨架畫面，不整頁轉圈（MIL-182）。
export default function Loading() {
  return <ListPageSkeleton />;
}
