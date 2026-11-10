import DetailPageSkeleton from '@/components/page/DetailPageSkeleton';

// 案件詳情載入中：顯示骨架畫面，不整頁轉圈（MIL-184）。案件詳情的頁首沒有動作，所以骨架也不畫。
export default function Loading() {
  return <DetailPageSkeleton withAction={false} />;
}
