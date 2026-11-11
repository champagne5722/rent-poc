'use client';

// 建約精靈的物件摘要（MIL-209，ADR-0029 決議 1）：物件由入口帶入，精靈不再選物件，這裡只唯讀顯示。
// 草稿建立時，物件資料在伺服端帶入成快照（見 docs/domain-model.md），所以這裡的值只是建立前的預覽。

import { Descriptions } from 'antd';
import { DisplayCode } from '@/components/DisplayCode';
import { formatEquipmentItem } from '@/lib/equipment';
import { unitFullText } from '@/lib/properties/unit-display';
import type { Property } from '@/lib/types';

export default function PropertySummary({ property }: { property: Property }) {
  return (
    <Descriptions
      column={1}
      size="small"
      aria-label="出租物件"
      items={[
        { key: 'name', label: '名稱', children: property.name },
        ...(property.unit
          ? [
              { key: 'code', label: '顯示編碼', children: <DisplayCode code={property.unit.display_code} /> },
              { key: 'unit', label: '單位', children: unitFullText(property.unit) },
            ]
          : []),
        { key: 'address', label: '地址', children: property.address },
        { key: 'type', label: '型態', children: property.type },
        { key: 'size', label: '坪數', children: property.size != null ? `${property.size} 坪` : '—' },
        { key: 'rent', label: '預設租金', children: property.default_rent != null ? `$${property.default_rent.toLocaleString('en-US')}` : '—' },
        { key: 'equipment', label: '附屬設備', children: property.equipment.length ? property.equipment.map(formatEquipmentItem).join('、') : '—' },
      ]}
    />
  );
}
