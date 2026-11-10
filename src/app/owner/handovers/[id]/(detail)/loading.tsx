import DetailPageSkeleton from '@/components/page/DetailPageSkeleton';

// 屋主端移交詳情載入中：顯示骨架畫面，不整頁轉圈（MIL-182）。
export default function Loading() {
  return <DetailPageSkeleton withAction={false} />;
}
