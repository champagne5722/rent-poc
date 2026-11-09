import { jsonOk } from '@/lib/http';
import { listCities } from '@/lib/registry/section-code';
import { SECTION_CODE_SEED } from '@/lib/registry/section-code/seed-data';

// 縣市與鄉鎮市區編碼表（MIL-143）。公開的政府資料，不需要組織脈絡，也不碰資料庫。
// 執行期不呼叫外部服務：資料來自提交進 repo 的 seed 檔（ADR-0025 決議 1）。
export async function GET() {
  return jsonOk({ data: { cities: listCities(SECTION_CODE_SEED), towns: SECTION_CODE_SEED.towns } });
}
