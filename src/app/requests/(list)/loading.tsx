import ListPageSkeleton from '@/components/page/ListPageSkeleton';

// 申請列表載入中：顯示骨架畫面，不整頁轉圈（MIL-206 畫面段）。
export default function Loading() {
  return <ListPageSkeleton withAction={false} />;
}
