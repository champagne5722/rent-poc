import type { NextRequest } from 'next/server';
import type { BusinessType } from '@/lib/labels';
import { jsonError, jsonOk } from '@/lib/http';
import { inOrgTx } from '@/lib/org-route';
import { LOOKUP_MAX_IDS, lookupPracticeEntities } from '@/lib/practice-entities';
import { isUlid } from '@/lib/pg/ulid';

// 執業主體批次查詢（MIL-109，F 線資產總覽 MIL-94）。ids 以逗號分隔，一次查詢完成。
// 回傳名稱、法定稱謂、各業別的驗證狀態。不回統編、組織 ID、人員（ADR-0012 決議 8）。
// businessType（self_managed、managed、master_lease）給了，兼營的稱謂才能決定。

const BUSINESS_TYPES: readonly string[] = ['self_managed', 'managed', 'master_lease'];

export async function GET(request: NextRequest): Promise<Response> {
  const params = request.nextUrl.searchParams;
  const ids = (params.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return jsonOk({ data: { entities: [] } });
  if (ids.length > LOOKUP_MAX_IDS) return jsonError(400, `一次最多查 ${LOOKUP_MAX_IDS} 個執業主體`);
  const businessType = params.get('businessType');
  if (businessType !== null && !BUSINESS_TYPES.includes(businessType)) return jsonError(400, '業務類型不合法');
  // 格式不合的 ID 當作查無，不報錯，也不送進資料庫
  const valid = ids.filter(isUlid);
  return inOrgTx(async (tx) =>
    jsonOk({ data: { entities: await lookupPracticeEntities(tx, valid, businessType ? { businessType: businessType as BusinessType } : {}) } }),
  );
}
