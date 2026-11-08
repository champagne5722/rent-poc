import { NextRequest } from 'next/server';
import { jsonError, jsonOk } from '@/lib/http';
import { listSections, searchSections, sectionLabel } from '@/lib/registry/section-code';
import { SECTION_CODE_SEED } from '@/lib/registry/section-code/seed-data';

// 某縣市鄉鎮市區可選的段小段（MIL-143）。公開的政府資料，不需要組織脈絡，也不碰資料庫。
// 已註銷的段不列出。跨越段從別名行政區也選得到：via_alias 為 true 時，鍵仍存主行政區（ADR-0025 決議 4）。
// 單一鄉鎮的段最多一百多筆，所以預設全列，前端在選單內過濾；帶 q 時由伺服器用段名搜尋。
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const city = searchParams.get('city');
  const town = searchParams.get('town');
  if (!city || !town) return jsonError(400, '必須帶縣市與鄉鎮市區');
  const q = searchParams.get('q')?.slice(0, 20);

  const options = q
    ? searchSections(SECTION_CODE_SEED, q, { cityCode: city, townCode: town })
    : listSections(SECTION_CODE_SEED, city, town);
  return jsonOk({
    data: options.map(({ section, viaAlias }) => ({
      code: section.code,
      label: sectionLabel(section),
      via_alias: viaAlias,
    })),
  });
}
