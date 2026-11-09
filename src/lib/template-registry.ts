// 範本登錄（MIL-73、ADR-0005）：平台提供的範本依合約類型查詢，法務審閱旗標也在這裡。
// 只有純資料與純函式，沒有 fs，client 端的 wizard 也能引用。
//
// 新增合約類型的範本時，只在 TEMPLATES 與 OPTIONAL_CLAUSE_LIBRARIES 加一列（委託管理合約屬 MIL-74）。
// 範本與選用條款的版本、快照與升版機制仍在 clause-library.ts，這裡不重寫。

import { DEFAULT_TEMPLATE, OPTIONAL_CLAUSES } from './clause-library';
import type { ContractType } from './labels';
import type { ContractTemplate, OptionalClause, TemplateBinding } from './types';

/** 各合約類型的範本，版本由舊到新。 */
export type TemplateRegistry = Readonly<Record<ContractType, readonly ContractTemplate[]>>;

/** 各合約類型提供的範本。委託管理合約在 MIL-74 之前沒有範本。 */
export const TEMPLATES: TemplateRegistry = {
  lease: [DEFAULT_TEMPLATE],
  management: [],
};

/** 各合約類型的選用條款庫。 */
export const OPTIONAL_CLAUSE_LIBRARIES: Readonly<Record<ContractType, readonly OptionalClause[]>> = {
  lease: OPTIONAL_CLAUSES,
  management: [],
};

export function templatesFor(
  contractType: ContractType,
  registry: TemplateRegistry = TEMPLATES,
): readonly ContractTemplate[] {
  return registry[contractType];
}

/** 建約時綁定的範本：該類型最新的版本。沒有範本回 null。 */
export function currentTemplate(
  contractType: ContractType,
  registry: TemplateRegistry = TEMPLATES,
): ContractTemplate | null {
  const templates = templatesFor(contractType, registry);
  return templates.length ? templates[templates.length - 1] : null;
}

export function optionalClausesFor(contractType: ContractType): readonly OptionalClause[] {
  return OPTIONAL_CLAUSE_LIBRARIES[contractType];
}

/**
 * 合約綁的那個範本版本。依 templateId 與 templateVersion 在登錄查，查不到回 null：
 * 早期沒綁版本的草稿、已不在登錄的舊版，或綁了別的合約類型的範本。
 */
export function boundTemplateOf(
  contractType: ContractType,
  binding: TemplateBinding,
  registry: TemplateRegistry = TEMPLATES,
): ContractTemplate | null {
  if (binding.templateId === undefined || binding.templateVersion === undefined) return null;
  return (
    templatesFor(contractType, registry).find(
      (t) => t.id === binding.templateId && t.version === binding.templateVersion,
    ) ?? null
  );
}

/** 合約綁的範本是否經法務審閱。查不到範本一律視為未審閱。 */
export function isLegalReviewed(
  contractType: ContractType,
  binding: TemplateBinding,
  registry: TemplateRegistry = TEMPLATES,
): boolean {
  return boundTemplateOf(contractType, binding, registry)?.legalReviewed === true;
}
