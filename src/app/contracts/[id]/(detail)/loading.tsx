import DetailPageSkeleton from '@/components/page/DetailPageSkeleton';

// 合約詳情載入中：顯示骨架畫面，不整頁轉圈（MIL-175）。草稿與已完成的頁首有動作，其他狀態沒有，
// 載入前不知道狀態，所以骨架固定畫動作，寧可多一塊也不讓載入完成後版面位移。
export default function Loading() {
  return <DetailPageSkeleton />;
}
