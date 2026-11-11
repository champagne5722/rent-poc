import DetailPageSkeleton from '@/components/page/DetailPageSkeleton';

// 申請詳情載入中：顯示骨架畫面，不整頁轉圈（MIL-206 畫面段）。
export default function Loading() {
  return <DetailPageSkeleton withAction={false} />;
}
