import ListPageSkeleton from '@/components/page/ListPageSkeleton';

// 通知清單載入中：顯示骨架畫面，不整頁轉圈（MIL-179）。頁首右側是次要按鈕，骨架不畫主要動作。
export default function Loading() {
  return <ListPageSkeleton withAction={false} />;
}
