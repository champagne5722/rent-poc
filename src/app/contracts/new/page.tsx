'use client';

// 建約 wizard 第①步（規格 §7）：選物件並帶入快照建立草稿，接著進 /contracts/[id]/edit 續走後三步。
// 範本區單範本時只是說明，不做選擇（ADR-0005）；選用條款在草稿建立後的第①步勾選。

import { useEffect, useState } from 'react';
import { App as AntApp, Alert, Button, Card, Descriptions, Select, Space, Spin, Typography } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ContractRoutingConditions, Property } from '@/lib/types';
import { formatEquipmentItem } from '@/lib/equipment';
import { STEP_PROPERTY } from '@/lib/contract-wizard';
import { DEFAULT_ROUTING, evaluateRouting } from '@/lib/signature-routing';
import { TemplateNotice, WizardStepsBar } from '@/components/ContractWizard';
import RoutingConditionsPanel from '@/components/RoutingConditionsPanel';

function NewContractWizard() {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [properties, setProperties] = useState<Property[] | null>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [routing, setRouting] = useState<ContractRoutingConditions>(DEFAULT_ROUTING);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetch('/api/properties')
      .then((r) => r.json())
      .then((j) => setProperties(j.data ?? []));
  }, []);

  const selected = properties?.find((p) => p.id === propertyId) ?? null;

  // 建立草稿即完成第①步：物件資料在此帶入成快照（見 docs/domain-model.md）
  const createDraft = async () => {
    if (propertyId == null) {
      message.error('請先選擇要出租的物件');
      return;
    }
    // 規則未定義的分流條件擋下一步，原因已顯示在分流條件區
    const routingEvaluation = evaluateRouting(routing);
    if (!routingEvaluation.ok) {
      message.error(routingEvaluation.reason);
      return;
    }
    setCreating(true);
    const res = await fetch('/api/contracts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ property_id: propertyId, routing }),
    });
    const json = await res.json();
    if (!res.ok) {
      setCreating(false);
      message.error(json.error ?? '建立草稿失敗');
      return;
    }
    // replace：草稿已建立，回上一頁不該再回到空白的建約起點
    router.replace(`/contracts/${json.data.id}/edit`);
  };

  if (!properties) return <Spin style={{ display: 'block', margin: '64px auto' }} />;

  return (
    <>
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 12 }}>
        建立合約
      </Typography.Title>
      <WizardStepsBar current={STEP_PROPERTY} />

      {properties.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message="還沒有物件可以出租"
          description="合約的物件資料由物件帶入，請先新增一個物件再回來建約。"
          action={
            <Link href="/properties">
              <Button size="small" type="primary">
                去新增物件
              </Button>
            </Link>
          }
        />
      ) : (
        <Card size="small" style={{ maxWidth: 760 }}>
          <Space orientation="vertical" size={12} style={{ width: '100%' }}>
            <div>
              <Typography.Text strong>出租物件</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 8 }}
                placeholder="選擇要出租的物件"
                value={propertyId}
                onChange={setPropertyId}
                options={properties.map((p) => ({ value: p.id, label: `${p.name}（${p.address}）` }))}
              />
            </div>

            {selected && (
              <Descriptions
                column={1}
                size="small"
                items={[
                  { key: 'address', label: '地址', children: selected.address },
                  { key: 'type', label: '型態', children: selected.type },
                  { key: 'size', label: '坪數', children: selected.size != null ? `${selected.size} 坪` : '—' },
                  {
                    key: 'rent',
                    label: '預設租金',
                    children: selected.default_rent != null ? `$${selected.default_rent.toLocaleString()}` : '—',
                  },
                  {
                    key: 'equipment',
                    label: '附屬設備',
                    children: selected.equipment.length
                      ? selected.equipment.map(formatEquipmentItem).join('、')
                      : '—',
                  },
                ]}
              />
            )}

            <RoutingConditionsPanel value={routing} onChange={setRouting} disabled={creating} />

            <Alert
              type="info"
              showIcon
              message="屋主組織建立合約時，會同時建立一個自管租賃案件，合約掛在案件下。撤回或拒簽後複製的新草稿留在同一個案件。"
            />

            <TemplateNotice />
          </Space>
        </Card>
      )}

      {properties.length > 0 && (
        <Space style={{ marginTop: 16 }}>
          <Button type="primary" loading={creating} onClick={createDraft}>
            下一步 <RightOutlined />
          </Button>
        </Space>
      )}
    </>
  );
}

export default function Page() {
  return (
    <AntApp>
      <NewContractWizard />
    </AntApp>
  );
}
