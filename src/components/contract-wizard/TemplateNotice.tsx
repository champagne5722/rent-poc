'use client';

import { Alert } from 'antd';
import type { ContractType } from '@/lib/labels';
import { DEFAULT_CONTRACT_TYPE } from '@/lib/contract-types';
import { currentTemplate } from '@/lib/template-registry';

/** 範本區：單範本時顯示為說明，不做選擇（ADR-0005）。範本依合約類型從範本登錄取。 */
export function TemplateNotice({ contractType = DEFAULT_CONTRACT_TYPE }: { contractType?: ContractType }) {
  const template = currentTemplate(contractType);
  if (!template) return null;
  return (
    <Alert
      type="info"
      showIcon
      message={`範本：${template.name} v${template.version}，${template.provider}`}
      description={`${template.note}目前平台僅一份範本，系統自動選用。`}
    />
  );
}
