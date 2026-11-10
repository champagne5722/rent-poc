import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonError, jsonOk } from '@/lib/http';
import { inOrgTxAs, readJson } from '@/lib/org-route';
import { getPropertyOwnership, recordTranscriptConsent } from '@/lib/ownership';
import { isUlid } from '@/lib/pg/ulid';
import { propertyNotFound } from '@/lib/properties/not-found';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 記錄謄本與身分證件個資告知的同意或反對（MIL-201，ADR-0026 決議 8，P0-08 AC9）。body：{ decision: 'agree' | 'object' }。
 * 以 recordConsent 記錄，對象是目前的使用者，同交易寫稽核事件。同意後 GET .../ownership 的 consent.agreed 為 true，才能開啟上傳頁。
 * 回應是更新後的所有權文件狀態（PropertyOwnership）。
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return propertyNotFound();
  const body = (await readJson(request)) as { decision?: unknown } | null;
  const decision = body?.decision;
  if (decision !== 'agree' && decision !== 'object') return jsonError(400, 'decision 必須是 agree 或 object');
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'property.manage', { type: 'property', id });
    if (!(await recordTranscriptConsent(tx, id, rc.partyId, decision))) return propertyNotFound();
    const ownership = await getPropertyOwnership(tx, id, rc.partyId);
    if (!ownership) return propertyNotFound();
    return jsonOk({ data: ownership });
  });
}
