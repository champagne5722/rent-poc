import DetailPageSkeleton from '@/components/page/DetailPageSkeleton';

// 出租權源核對載入中：顯示骨架畫面，不整頁轉圈（MIL-201）。這頁沒有頁首動作。
export default function Loading() {
  return <DetailPageSkeleton withAction={false} />;
}
