'use client';

// 草稿續編：建約 wizard 的第②〜④步（規格 §7）。第①步在 /contracts/new。
// 進來時由 resumeStepIndex 決定停在哪一步，中斷後可續作。

import { use } from 'react';
import { App as AntApp } from 'antd';
import ContractWizard from '@/components/ContractWizard';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <AntApp>
      <ContractWizard id={id} />
    </AntApp>
  );
}
