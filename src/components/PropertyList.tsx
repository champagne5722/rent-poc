'use client';

import { useMemo, useState, useTransition } from 'react';
import { App as AntApp, Button, Flex, Input, Popconfirm, Switch, Table, Tag, Typography } from 'antd';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DisplayCode } from '@/components/DisplayCode';
import ListPage from '@/components/page/ListPage';
import PropertyEditorModal from '@/components/PropertyEditorModal';
import StatusTag from '@/components/StatusTag';
import { formatEquipmentItem } from '@/lib/equipment';
import { anchorSummary } from '@/lib/properties/anchor-display';
import {
  archivedUnitCount,
  countGroupsByStatus,
  EMPTY_PROPERTY_LIST_FILTER,
  isPropertyListFilterActive,
  representativeUnit,
  selectPropertyGroups,
  type PropertyListFilter,
} from '@/lib/properties/group-list';
import { unitShortText } from '@/lib/properties/unit-display';
import { statusPresentation } from '@/lib/status-presentation';
import { PROPERTY_VERIFICATION_STATUSES, type EquipmentVocabularyItem, type PropertyGroup, type PropertyGroupUnit } from '@/lib/types';
import styles from './PropertyList.module.css';

// 物件列表（MIL-177，ADR-0027 決議 5）：一列是一個物件，展開列是它底下自己組織的租賃單位。
// 資料由 server component 載入後傳進來，這裡只管篩選、展開與列上操作。
// 列上操作成功後呼叫 router.refresh()，讓 server component 重新載入資料。
// 建立合約的入口在租賃單位列，物件還沒通過文件核對時不出現（ADR-0029 決議 1）。

export interface PropertyListProps {
  groups: PropertyGroup[];
  vocabulary: EquipmentVocabularyItem[];
}

/** 金額固定用 en-US 分組：server 與瀏覽器的語系不同時，輸出也一致。 */
const formatRent = (rent: number | null): string => (rent != null ? `$${rent.toLocaleString('en-US')}` : '—');

function PropertyListInner({ groups, vocabulary }: PropertyListProps) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [filter, setFilter] = useState<PropertyListFilter>(EMPTY_PROPERTY_LIST_FILTER);
  const [editing, setEditing] = useState<PropertyGroupUnit | 'new' | null>(null);
  // 預設展開所有物件，列出底下的租賃單位。使用者收合的物件記在這裡，重新載入後仍維持
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);

  const rows = useMemo(() => selectPropertyGroups(groups, filter), [groups, filter]);
  const counts = useMemo(() => countGroupsByStatus(groups, filter), [groups, filter]);
  const archivedCount = useMemo(() => archivedUnitCount(groups), [groups]);
  const totalVisible = counts.pending_verification + counts.verified + counts.failed;
  const refresh = () => startRefresh(() => router.refresh());
  const patchFilter = (patch: Partial<PropertyListFilter>) => setFilter((f) => ({ ...f, ...patch }));

  const remove = async (id: string) => {
    const res = await fetch(`/api/properties/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok) {
      message.error(json.error ?? '刪除失敗');
    } else if (json.data.result === 'archived') {
      message.success('物件已有案件或合約，已改為封存');
    } else {
      message.success('物件已刪除');
    }
    refresh();
  };

  const createContract = async (propertyId: string) => {
    const res = await fetch('/api/contracts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ property_id: propertyId }),
    });
    const json = await res.json();
    if (!res.ok) {
      message.error(json.error ?? '建立合約失敗');
      return;
    }
    // 從物件建約＝wizard 第①步已完成，直接進 wizard 續走後續步驟
    router.push(`/contracts/${json.data.id}/edit`);
  };

  const unitTable = (group: PropertyGroup) => (
    <div className={styles.units}>
      <Table<PropertyGroupUnit>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={group.units}
        aria-label={`${representativeUnit(group).name}的租賃單位`}
        columns={[
          {
            // 租賃單位的顯示編碼（GLOSSARY「顯示編碼」），不含建號，口頭溝通與客服對照用。不保證唯一
            title: '顯示編碼',
            width: 128,
            render: (_, unit) => <DisplayCode code={unit.unit?.display_code} />,
          },
          { title: '單位', width: 96, render: (_, unit) => (unit.unit ? unitShortText(unit.unit) : '—') },
          {
            title: '名稱',
            dataIndex: 'name',
            render: (name: string, unit) => (
              <Flex align="center" gap="small" wrap>
                <Link href={`/properties/${unit.id}`}>{name}</Link>
                {unit.archived_at && <Tag>已封存</Tag>}
              </Flex>
            ),
          },
          { title: '型態', dataIndex: 'type', width: 96 },
          { title: '坪數', dataIndex: 'size', width: 64, render: (v: number | null) => v ?? '—' },
          { title: '預設租金', dataIndex: 'default_rent', width: 96, render: formatRent },
          {
            title: '設備',
            dataIndex: 'equipment',
            render: (equipment: PropertyGroupUnit['equipment']) =>
              equipment.length ? (
                <Flex wrap gap="var(--space-xxs)" className={styles.unitTags}>
                  {equipment.map((e) => (
                    <Tag key={e.name}>{formatEquipmentItem(e)}</Tag>
                  ))}
                </Flex>
              ) : (
                '—'
              ),
          },
          {
            // 操作欄放最右，用文字連結，最常用的動作放第一個（docs/ui/composite-components.md）
            title: '操作',
            width: 190,
            render: (_, unit) =>
              unit.archived_at ? (
                <Typography.Text type="secondary">已封存，唯讀</Typography.Text>
              ) : (
                <Flex align="center">
                  {group.verification_status === 'verified' && (
                    <Button type="link" size="small" onClick={() => void createContract(unit.id)}>
                      建立合約
                    </Button>
                  )}
                  <Button type="link" size="small" onClick={() => setEditing(unit)}>
                    編輯
                  </Button>
                  <Popconfirm
                    title="確定刪除此物件？"
                    description="有案件或合約的物件會改為封存，不會刪除。"
                    okText="刪除"
                    cancelText="取消"
                    onConfirm={() => void remove(unit.id)}
                  >
                    <Button type="link" size="small" danger>
                      刪除
                    </Button>
                  </Popconfirm>
                </Flex>
              ),
          },
        ]}
      />
    </div>
  );

  return (
    <>
      <ListPage<PropertyGroup, PropertyListFilter['status']>
        header={{
          title: '物件列表',
          extra: (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
              新增物件
            </Button>
          ),
        }}
        filter={{
          status: {
            value: filter.status,
            onChange: (status) => patchFilter({ status }),
            options: [
              { value: 'all', label: '全部', count: totalVisible },
              ...PROPERTY_VERIFICATION_STATUSES.map((s) => ({
                value: s,
                label: statusPresentation('propertyVerification', s).label,
                count: counts[s],
              })),
            ],
          },
          active: isPropertyListFilterActive(filter),
          onClear: () => setFilter(EMPTY_PROPERTY_LIST_FILTER),
          children: (
            <>
              <Input
                allowClear
                placeholder="搜尋名稱、地址、建號、顯示編碼"
                prefix={<SearchOutlined aria-hidden />}
                value={filter.keyword}
                onChange={(e) => patchFilter({ keyword: e.target.value })}
                className={styles.search}
                aria-label="搜尋物件"
              />
              {archivedCount > 0 && (
                <Flex align="center" gap="small">
                  <Switch size="small" checked={filter.showArchived} onChange={(showArchived) => patchFilter({ showArchived })} aria-label="顯示已封存的物件" />
                  <Typography.Text type="secondary">顯示已封存（{archivedCount}）</Typography.Text>
                </Flex>
              )}
            </>
          ),
        }}
        empty={{
          description: '尚無物件。登錄第一個物件，通過平台文件核對後就能建立合約。',
          action: (
            <Button icon={<PlusOutlined />} onClick={() => setEditing('new')}>
              新增物件
            </Button>
          ),
        }}
        table={{
          rowKey: 'id',
          dataSource: rows,
          // 欄寬明確，1440 寬、側欄展開時不必橫向捲動；視窗更窄時才捲動，操作欄固定在右側（比照合約列表）
          scroll: { x: 960 },
          expandable: {
            expandedRowRender: unitTable,
            expandedRowKeys: rows.map((g) => g.id).filter((id) => !collapsed.includes(id)),
            onExpand: (expanded, group) => setCollapsed((c) => (expanded ? c.filter((id) => id !== group.id) : [...c, group.id])),
          },
          columns: [
            {
              title: '物件',
              width: 200,
              render: (_, group) => <Link href={`/properties/${group.id}`}>{representativeUnit(group).name}</Link>,
            },
            { title: '地址', dataIndex: 'address', width: 240 },
            { title: '建號', width: 240, render: (_, group) => anchorSummary(group.anchor) },
            { title: '核對狀態', width: 150, render: (_, group) => <StatusTag kind="propertyVerification" value={group.verification_status} /> },
            { title: '租賃單位', width: 96, render: (_, group) => `${group.units.length} 個` },
            {
              title: '操作',
              width: 80,
              fixed: 'right',
              render: (_, group) => (
                <Link href={`/properties/${group.id}`}>
                  <Button type="link" size="small">
                    查看
                  </Button>
                </Link>
              ),
            },
          ],
        }}
      />
      <PropertyEditorModal editing={editing} vocabulary={vocabulary} onClose={() => setEditing(null)} onSaved={refresh} />
    </>
  );
}

export default function PropertyList(props: PropertyListProps) {
  return (
    <AntApp>
      <PropertyListInner {...props} />
    </AntApp>
  );
}
