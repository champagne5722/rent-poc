'use server';

// 屋主端移交的 Server Actions。每個 action 都先讀屋主身分，service 再檢查移交屬於這位屋主。
import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { currentOwnerSession } from '@/lib/current-owner-session';
import { handoverStore } from '@/lib/handover/demo-store';
import {
  cancelHandover,
  confirmHandover,
  saveManualFields,
  startHandovers,
  type ConfirmHandoverInput,
  type ServiceResult,
} from '@/lib/handover/service';
import type { HandoverManualFields } from '@/lib/handover/snapshot';

const NO_OWNER: ServiceResult = { ok: false, errors: ['目前的帳號沒有屋主身分。'] };

export async function startHandoversAction(mandateCaseId: string): Promise<ServiceResult> {
  const session = await currentOwnerSession();
  if (!session) return NO_OWNER;
  const result = await startHandovers(handoverStore(), session.partyId, mandateCaseId, new Date());
  if (!result.ok) return result;
  redirect(`/owner/handovers?created=${result.value.length}`);
}

export async function saveManualFieldsAction(id: string, manual: HandoverManualFields): Promise<ServiceResult> {
  const session = await currentOwnerSession();
  if (!session) return NO_OWNER;
  const result = await saveManualFields(handoverStore(), session.partyId, id, manual, new Date());
  if (result.ok) refresh();
  return result;
}

export async function confirmHandoverAction(id: string, input: ConfirmHandoverInput): Promise<ServiceResult> {
  const session = await currentOwnerSession();
  if (!session) return NO_OWNER;
  const result = await confirmHandover(handoverStore(), session.partyId, id, input, new Date());
  if (result.ok) refresh();
  return result;
}

export async function cancelHandoverAction(id: string): Promise<ServiceResult> {
  const session = await currentOwnerSession();
  if (!session) return NO_OWNER;
  const result = await cancelHandover(handoverStore(), session.partyId, id, new Date());
  if (result.ok) refresh();
  return result;
}
