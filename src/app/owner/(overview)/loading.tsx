import ListPageSkeleton from '@/components/page/ListPageSkeleton';

// 屋主資產總覽載入中：顯示骨架畫面，不整頁轉圈（MIL-182）。放在 (overview) 路由群組，骨架只套用在總覽。
export default function Loading() {
  return <ListPageSkeleton withAction={false} />;
}
