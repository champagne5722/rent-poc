// 屋主端的 layout：在 server 端讀屋主身分，交給 OwnerShell。
// AppShell 遇到 /owner 底下的路徑不套後台殼層，殼層由這裡提供（見 AppShell.tsx）。
import OwnerShell from '@/components/OwnerShell';
import { currentOwnerSession } from '@/lib/current-owner-session';

export default async function OwnerLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await currentOwnerSession();
  return <OwnerShell session={session}>{children}</OwnerShell>;
}
