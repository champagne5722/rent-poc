import DetailPageSkeleton from '@/components/page/DetailPageSkeleton';

// 屋主端案件詳情載入中：顯示骨架畫面，不整頁轉圈（MIL-184）。
export default function Loading() {
  return <DetailPageSkeleton withAction={false} />;
}
