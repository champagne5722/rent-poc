// 承租人端的 layout（MIL-121）：在 server 端讀承租人身分，交給 TenantShell。
// AppShell 遇到 /tenant 底下的路徑不套後台殼層，殼層由這裡提供（見 AppShell.tsx）。
import TenantShell from '@/components/TenantShell';
import { currentTenantSession } from '@/lib/current-tenant-session';

export default async function TenantLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await currentTenantSession();
  return <TenantShell session={session}>{children}</TenantShell>;
}
