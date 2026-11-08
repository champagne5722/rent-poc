'use server';

// 後台移交的 Server Actions。每個 action 都先讀組織身分，service 再檢查組織是交出方或接收方。
import { refresh } from 'next/cache';
import { currentPracticeOrgSession } from '@/lib/current-practice-org-session';
import { simulateReceive, simulateRelease } from '@/lib/handover/demo-effective';
import { HANDOVER_SIMULATION_AVAILABLE, handoverStore } from '@/lib/handover/demo-store';
import { acceptHandover } from '@/lib/handover/org-service';
import type { ServiceResult } from '@/lib/handover/service';

const NO_ORG: ServiceResult = { ok: false, errors: ['目前的帳號不屬於任何執業主體。'] };

const text = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
};

/** 檔案經 FormData 傳上來，才能在伺服器端算雜湊。 */
export async function acceptHandoverAction(id: string, formData: FormData): Promise<ServiceResult> {
  const session = await currentPracticeOrgSession();
  if (!session) return NO_ORG;
  const file = formData.get('evidenceFile');
  const evidenceFile =
    file instanceof File && file.size > 0 ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
  const result = await acceptHandover(
    handoverStore(),
    session.orgId,
    id,
    {
      effectiveDate: text(formData, 'effectiveDate'),
      paymentAccountId: text(formData, 'paymentAccountId'),
      evidenceNote: text(formData, 'evidenceNote'),
      evidenceFile,
    },
    new Date(),
  );
  if (result.ok) refresh();
  return result;
}

const SIMULATION_OFF: ServiceResult = { ok: false, errors: ['模擬生效只在記憶體 adapter 提供。'] };

export async function simulateReleaseAction(id: string): Promise<ServiceResult> {
  if (!HANDOVER_SIMULATION_AVAILABLE) return SIMULATION_OFF;
  const session = await currentPracticeOrgSession();
  if (!session) return NO_ORG;
  const result = await simulateRelease(handoverStore(), session.orgId, id, new Date());
  if (result.ok) refresh();
  return result;
}

export async function simulateReceiveAction(id: string): Promise<ServiceResult> {
  if (!HANDOVER_SIMULATION_AVAILABLE) return SIMULATION_OFF;
  const session = await currentPracticeOrgSession();
  if (!session) return NO_ORG;
  const result = await simulateReceive(handoverStore(), session.orgId, id, new Date());
  if (result.ok) refresh();
  return result;
}
