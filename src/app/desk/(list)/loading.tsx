import ListPageSkeleton from '@/components/page/ListPageSkeleton';

// 審核台佇列載入中：顯示骨架畫面，不整頁轉圈（MIL-180）。這頁沒有頁首動作。
export default function Loading() {
  return <ListPageSkeleton withAction={false} />;
}
