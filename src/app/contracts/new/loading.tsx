import WizardSkeleton from '@/components/contract-wizard/WizardSkeleton';

// 建約精靈入口載入中：顯示骨架畫面，不整頁轉圈（MIL-176）。
export default function Loading() {
  return <WizardSkeleton />;
}
