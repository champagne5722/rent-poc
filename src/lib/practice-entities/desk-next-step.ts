import type { StatusTone } from '../status-presentation';
import { resolutionLabel } from './display';

// 審核台項目詳情頂端的「下一步」（MIL-180）。出租權源項目有自己的版本（OwnershipReviewPanel），這裡管其餘類型。
// 純函式。文案不暗示平台的判定具法律效力：判定只是平台營運者的人工核對紀錄。

export interface DeskNextStep {
  headline: string;
  owner: string;
  detail: string;
  tone: StatusTone;
}

export interface DeskNextStepInput {
  type: string;
  status: 'open' | 'resolved';
  resolution: string | null;
}

const OPEN_HEADLINES: Record<string, string> = {
  license: '查商工登記，登錄業別核對結果',
  entity_claim: '對照兩邊的證明文件，判定統編歸屬',
  certificate: '查 resim 證書，登錄核對結果',
  employment: '查 resim 任職，登錄核對結果',
  consent: '核對所屬業者同意書，登錄結果',
  anchor_collision: '判定功能尚未開放，目前只能查看',
  anchor_collision_limit: '判定功能尚未開放，目前只能查看',
};

const OPEN_DETAILS: Record<string, string> = {
  license: '系統不接外部查詢。商工登記與 resim 都由營運者人工查詢、人工登錄。',
  entity_claim: '判定結果只通知認領方，不通知原登錄者。',
  certificate: '相符時登錄 resim 查到的效期，以它為準。',
  employment: '同一證號在別的執業主體也有任職時，依 resim 任職查詢判定哪一家相符。',
  consent: '同意書相符後，任職標示「經所屬業者同意」。',
  anchor_collision: '撞號的判定（同一產權、退回補件）會在後續功能提供。宣稱方的物件已建立，產權維持待驗證。',
  anchor_collision_limit: '這個組織 24 小時內遇到已登錄產權的次數已達上限。之後會提供處理方式。',
};

/** 項目的下一步。待核對時由平台營運者處理，已結案時不需要處理。 */
export function deskNextStep(item: DeskNextStepInput): DeskNextStep {
  if (item.status === 'open') {
    return {
      headline: OPEN_HEADLINES[item.type] ?? '核對項目並登錄結果',
      owner: '平台營運者',
      detail: OPEN_DETAILS[item.type] ?? '核對後登錄結果。',
      tone: 'progress',
    };
  }
  const result = resolutionLabel(item.resolution);
  return {
    headline: result ? `已結案：${result}` : '已結案',
    owner: '平台營運者',
    detail: '這個項目已處理完畢，不需要再處理。',
    tone: item.resolution === 'match' || item.resolution === 'claim_to_claimant' ? 'success' : 'neutral',
  };
}
