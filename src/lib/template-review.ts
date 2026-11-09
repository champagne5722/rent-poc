// 未審閱範本的送簽閘門（MIL-73、P0-10 AC5）。
// 正式金鑰下，合約綁的範本未經法務審閱就無法送簽，避免示意條文用於真實簽約。
// 正式環境的判定沿用 DOTTEDSIGN_VERIFY_SIGNERS=1（MIL-65），不看部署環境，也不從金鑰字串推斷。
// Mock 與 sandbox 不受限。

import { verifySignersEnabled } from './dottedsign';
import type { ContractType } from './labels';
import { boundTemplateOf, TEMPLATES, type TemplateRegistry } from './template-registry';
import type { TemplateBinding } from './types';

export const TEMPLATE_NOT_REVIEWED_CODE = 'template_not_reviewed' as const;

export interface TemplateReviewBlock {
  code: typeof TEMPLATE_NOT_REVIEWED_CODE;
  message: string;
}

/**
 * @param env 環境變數。呼叫端傳 process.env，測試傳假值。
 * @returns 被擋下時回原因，放行回 null。
 */
export function templateReviewBlock(
  contractType: ContractType,
  binding: TemplateBinding,
  env: Record<string, string | undefined>,
  registry: TemplateRegistry = TEMPLATES,
): TemplateReviewBlock | null {
  if (!verifySignersEnabled(env)) return null;
  const template = boundTemplateOf(contractType, binding, registry);
  if (template?.legalReviewed) return null;
  return {
    code: TEMPLATE_NOT_REVIEWED_CODE,
    message: template
      ? `${template.name} v${template.version} 尚未經法務審閱，正式環境無法用它送簽`
      : '這份合約綁定的範本版本沒有法務審閱紀錄，正式環境無法用它送簽',
  };
}
