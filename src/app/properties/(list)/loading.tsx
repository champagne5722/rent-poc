import ListPageSkeleton from '@/components/page/ListPageSkeleton';

// 物件列表載入中：顯示骨架畫面，不整頁轉圈（MIL-177）。頁首有主要動作「新增物件」，骨架照畫。
export default function Loading() {
  return <ListPageSkeleton />;
}
