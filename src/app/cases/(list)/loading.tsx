import ListPageSkeleton from '@/components/page/ListPageSkeleton';

// 案件列表載入中：顯示骨架畫面，不整頁轉圈（MIL-184）。案件列表的頁首沒有主要動作，所以骨架也不畫。
export default function Loading() {
  return <ListPageSkeleton withAction={false} />;
}
