// 設計樣式頁（規格外的內部工具頁）：呈現 DESIGN.md 目前的 token 與元件樣式。
// server component 負責讀檔，資料是純 JSON，畫面交給 client 端的 DesignShowcase。
import DesignShowcase from '@/components/DesignShowcase';
import { loadDesignFrontMatter } from '@/lib/design-theme-loader';

export const dynamic = 'force-dynamic';

export default function DesignPage() {
  return <DesignShowcase data={loadDesignFrontMatter() ?? null} />;
}
