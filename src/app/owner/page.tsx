// 屋主資產總覽（MIL-96）。在 server 端讀事實並推導，client 元件只負責篩選與呈現。
// 資料來源目前是假資料 adapter；接線票（MIL-99、MIL-101、MIL-102）換成 PostgreSQL adapter，這裡不動。
import OwnerOverview from '@/components/OwnerOverview';
import { currentOwnerSession } from '@/lib/current-owner-session';
import { deriveAttention, deriveOverview } from '@/lib/owner-overview';
import { createFakeOverviewSource, todayInTaipei } from '@/lib/owner-overview-source';

const source = createFakeOverviewSource();

function formatAsOf(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

export default async function OwnerHomePage() {
  // 沒有屋主身分時，OwnerShell 顯示空狀態，不渲染這頁
  const session = await currentOwnerSession();
  if (!session) return null;

  const facts = await source.load(session);
  const today = todayInTaipei(new Date(facts.asOf));
  const { summary, rows } = deriveOverview(facts, today);

  return (
    <OwnerOverview
      summary={summary}
      rows={rows}
      attention={deriveAttention(rows, today)}
      asOfLabel={formatAsOf(facts.asOf)}
    />
  );
}
