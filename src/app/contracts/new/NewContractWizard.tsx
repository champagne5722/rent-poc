'use client';

// 建約精靈第一步（MIL-209、MIL-205，ADR-0029 決議 1）：物件與案件種類由入口帶入，精靈不再選物件。
// 入口參數 `/contracts/new?property=<物件 ID>&kind=<案件種類>` 由 page.tsx 解析，這裡拿到的已是合法的參數與已載入的物件。
// 合約類型、業務類型與「承租人是否為包租業者」由案件種類決定，使用者不選。只有「是否有經紀業者居間」由使用者填。
// 居間選項照 MIL-200 的規則顯示：屋主組織與沒有經紀業別的組織不顯示，經紀業別未驗證時顯示成不能選，已驗證才能勾。伺服端另外擋下，不信前端。
// 按「下一步」建立草稿：POST /api/contracts 帶 case_kind。伺服端回 409 時，顯示伺服端的原因與下一步的連結，不顯示錯誤碼。
// 範本區單範本時只是說明，不做選擇（ADR-0005）；選用條款在草稿建立後的第①步勾選。

import { useState } from 'react';
import { App as AntApp, Alert, Button, Card, Flex, Space, Typography } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { TemplateNotice, WizardStepsBar } from '@/components/ContractWizard';
import PropertySummary from '@/components/contract-wizard/PropertySummary';
import RoutingConditionsPanel from '@/components/RoutingConditionsPanel';
import StatusTag from '@/components/StatusTag';
import { businessTypeForNewCase } from '@/lib/cases';
import { contractTypeDefinition } from '@/lib/contract-types';
import { contractTypeForCaseKind } from '@/lib/contract-types/case-kind';
import { STEP_PROPERTY } from '@/lib/contract-wizard';
import type { BrokerChoice } from '@/lib/practitioner-assignment/broker-choice';
import { creationBlockedNext, PROPERTY_LIST_HREF, type CreationBlockedNext } from '@/lib/property-case-entry';
import type { OrgKind } from '@/lib/request-context';
import { DEFAULT_ROUTING, evaluateRouting } from '@/lib/signature-routing';
import { statusPresentation } from '@/lib/status-presentation';
import type { ContractRoutingConditions, Property, PropertyCaseKind } from '@/lib/types';
import styles from './NewContractWizard.module.css';

export interface NewContractWizardProps {
  property: Property;
  kind: PropertyCaseKind;
  orgKind: Exclude<OrgKind, 'platform'>;
  /** 居間選項的狀態，由伺服端依自家組織的經紀業別算出（MIL-200）。屋主組織與沒有經紀業別的組織是 hidden。 */
  brokerChoice: BrokerChoice;
}

interface Blocked {
  message: string;
  next: CreationBlockedNext;
}

function NewContractWizardInner({ property, kind, orgKind, brokerChoice }: NewContractWizardProps) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [brokerMediated, setBrokerMediated] = useState(false);
  const [creating, setCreating] = useState(false);
  const [blocked, setBlocked] = useState<Blocked | null>(null);

  const contractType = contractTypeForCaseKind(kind);
  const caseKindLabel = statusPresentation('caseKind', kind).label;
  // 業務類型與「承租人是否為包租業者」由案件種類決定，與伺服端的 routingForNewCase 相同。組織種類不能建這種案件時，伺服端回 409
  const routing: ContractRoutingConditions = {
    businessType: businessTypeForNewCase(orgKind, kind) ?? DEFAULT_ROUTING.businessType,
    lesseeIsMasterLessor: kind === 'master_lease',
    brokerMediated,
  };

  const createDraft = async () => {
    // 規則未定義的分流條件擋下一步，原因已顯示在分流條件區
    const evaluation = evaluateRouting(routing, contractType);
    if (!evaluation.ok) {
      message.error(evaluation.reason);
      return;
    }
    setCreating(true);
    setBlocked(null);
    const res = await fetch('/api/contracts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 只送「是否有經紀業者居間」。業務類型與包租業者旗標由案件種類決定，送了伺服端也忽略
      body: JSON.stringify({
        property_id: property.id,
        case_kind: kind,
        routing: { brokerMediated },
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      // replace：草稿已建立，回上一頁不該再回到空白的建約起點
      router.replace(`/contracts/${json.data.id}/edit`);
      return;
    }
    setCreating(false);
    if (res.status === 409) {
      setBlocked({
        message: json.error ?? '目前不能建立這個案件',
        next: creationBlockedNext(json.code, property.id),
      });
    } else if (res.status === 404) {
      setBlocked({
        message: json.error ?? '物件不存在',
        next: { href: PROPERTY_LIST_HREF, label: '返回物件列表' },
      });
    } else {
      message.error(json.error ?? '建立草稿失敗');
    }
  };

  return (
    <>
      <Typography.Title level={4} className={styles.title}>
        建立合約
      </Typography.Title>
      <WizardStepsBar current={STEP_PROPERTY} />

      <Flex vertical gap="small" className={styles.stack}>
        <Card size="small">
          <Flex vertical gap={12}>
            <Flex align="center" gap="small" wrap>
              <Typography.Text strong>案件種類</Typography.Text>
              <StatusTag kind="caseKind" value={kind} />
              <Typography.Text type="secondary">合約：{contractTypeDefinition(contractType).documentName}</Typography.Text>
            </Flex>
            <Typography.Text strong>出租物件</Typography.Text>
            <PropertySummary property={property} />
          </Flex>
        </Card>

        <Card size="small">
          <Flex vertical gap={12}>
            <RoutingConditionsPanel
              value={routing}
              onChange={(next) => setBrokerMediated(next.brokerMediated)}
              disabled={creating}
              brokerChoice={brokerChoice}
              caseDerived
            />
            <Alert
              type="info"
              showIcon
              title={`建立合約後，案件列表會多一個${caseKindLabel}。撤回或拒簽後複製的新草稿，會留在同一個案件。`}
            />
            <TemplateNotice contractType={contractType} />
          </Flex>
        </Card>

        {blocked && (
          <Alert
            type="error"
            showIcon
            title={blocked.message}
            action={
              <Link href={blocked.next.href}>
                <Button size="small">{blocked.next.label}</Button>
              </Link>
            }
          />
        )}

        <Space className={styles.actions}>
          <Button type="primary" loading={creating} onClick={() => void createDraft()}>
            下一步 <RightOutlined />
          </Button>
          <Link href={`${PROPERTY_LIST_HREF}/${property.id}`}>
            <Button disabled={creating}>返回物件</Button>
          </Link>
        </Space>
      </Flex>
    </>
  );
}

export default function NewContractWizard(props: NewContractWizardProps) {
  return (
    <AntApp>
      <NewContractWizardInner {...props} />
    </AntApp>
  );
}
