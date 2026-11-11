'use client';

// 建號欄位（MIL-143）：依序選縣市、鄉鎮市區、段小段，再填建號與分號。
// 物件建立（列表頁的 Modal）與補建號、修正建號（物件詳情頁）共用。元件一律用 antd，間距走 Row 的 gutter。
// 選單資料來自 /api/registry/*（伺服器端的 seed 檔），不呼叫外部服務。

import { useEffect, useState } from 'react';
import { Col, Form, Input, InputNumber, Row, Select, Typography } from 'antd';
import type { FormInstance } from 'antd';
import styles from './AnchorFields.module.css';

interface AreaData {
  cities: { code: string; name: string }[];
  towns: { cityCode: string; code: string; name: string }[];
}
interface SectionOption {
  code: string;
  label: string;
  via_alias: boolean;
}

// 縣市與鄉鎮市區編碼表全國只有 365 列，整份載入後留在模組內
let areasPromise: Promise<AreaData> | null = null;
function loadAreas(): Promise<AreaData> {
  areasPromise ??= fetch('/api/registry/areas')
    .then((res) => res.json())
    .then((json) => json.data as AreaData)
    .catch((error) => {
      areasPromise = null;
      throw error;
    });
  return areasPromise;
}

/** 「台」視同「臺」，搜尋時不分。 */
const toFormalTai = (text: string) => text.replace(/台/g, '臺').toLowerCase();

/** 選單搜尋：「台」視同「臺」，空白不影響。 */
const matchesLabel = (input: string, option?: { label?: unknown }) => {
  const squash = (text: string) => toFormalTai(text).replace(/\s+/g, "");
  return squash(String(option?.label ?? "")).includes(squash(input));
};

interface KeyFieldsProps {
  form: FormInstance;
  /** 欄位路徑的前綴，例如 ['anchor', 'key']。 */
  prefix: (string | number)[];
}

/** 縣市、鄉鎮市區、段小段、建號、分號。必須放在 Form 裡面。 */
export function AnchorKeyFields({ form, prefix }: KeyFieldsProps) {
  const [areas, setAreas] = useState<AreaData | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; options: SectionOption[] } | null>(null);
  const city: string | undefined = Form.useWatch([...prefix, 'city'], form);
  const town: string | undefined = Form.useWatch([...prefix, 'town'], form);
  const section: string | undefined = Form.useWatch([...prefix, 'section'], form);

  useEffect(() => {
    void loadAreas().then(setAreas, () => setAreas({ cities: [], towns: [] }));
  }, []);

  // 段小段隨縣市與鄉鎮市區載入。結果連同它屬於哪一組一起存：換了鄉鎮就視為還沒載入，不顯示上一組的段
  const sectionsKey = city && town ? `${city}:${town}` : null;
  useEffect(() => {
    if (!city || !town || !sectionsKey) return;
    let stale = false;
    void fetch(`/api/registry/sections?city=${encodeURIComponent(city)}&town=${encodeURIComponent(town)}`)
      .then((res) => res.json())
      .then((json) => (json.data ?? []) as SectionOption[])
      .catch(() => [] as SectionOption[])
      .then((options) => {
        if (!stale) setLoaded({ key: sectionsKey, options });
      });
    return () => {
      stale = true;
    };
  }, [city, town, sectionsKey]);
  const sections = loaded && loaded.key === sectionsKey ? loaded.options : [];
  const loadingSections = sectionsKey !== null && loaded?.key !== sectionsKey;

  const towns = areas?.towns.filter((t) => t.cityCode === city) ?? [];
  const picked = sections.find((s) => s.code === section);

  return (
    <>
      <Row gutter={16}>
        <Col xs={24} sm={8}>
          <Form.Item name={[...prefix, 'city']} label="縣市" rules={[{ required: true, message: '請選縣市' }]}>
            <Select
              showSearch={{ filterOption: matchesLabel }}
              placeholder="選縣市"
              loading={areas === null}
              options={areas?.cities.map((c) => ({ value: c.code, label: c.name }))}
              onChange={() => form.setFieldValue([...prefix, 'town'], undefined)}
            />
          </Form.Item>
        </Col>
        <Col xs={24} sm={8}>
          <Form.Item name={[...prefix, 'town']} label="鄉鎮市區" rules={[{ required: true, message: '請選鄉鎮市區' }]}>
            <Select
              showSearch={{ filterOption: matchesLabel }}
              placeholder={city ? '選鄉鎮市區' : '先選縣市'}
              disabled={!city}
              options={towns.map((t) => ({ value: t.code, label: t.name }))}
              onChange={() => form.setFieldValue([...prefix, 'section'], undefined)}
            />
          </Form.Item>
        </Col>
        <Col xs={24} sm={8}>
          <Form.Item
            name={[...prefix, 'section']}
            label="段小段"
            rules={[{ required: true, message: '請選段小段' }]}
            extra={picked?.via_alias ? '此段跨越多個鄉鎮市區，建號登記在主行政區，系統會自動處理。' : undefined}
          >
            <Select
              showSearch={{ filterOption: matchesLabel }}
              placeholder={town ? '輸入段名搜尋' : '先選鄉鎮市區'}
              disabled={!town}
              loading={loadingSections}
              notFoundContent={loadingSections ? '載入中' : '找不到符合的段小段，已註銷的段不會列出'}
              options={sections.map((s) => ({ value: s.code, label: `${s.label}（${s.code}）` }))}
            />
          </Form.Item>
        </Col>
      </Row>
      <Row gutter={16}>
        <Col xs={24} sm={8}>
          <Form.Item
            name={[...prefix, 'buildingNo']}
            label="建號"
            rules={[
              { required: true, message: '請填建號' },
              { pattern: /^(?!0+$)\d{1,5}$/, message: '建號為 1 到 5 位數字，不能全是 0' },
            ]}
            extra="不足 5 碼時系統補零"
          >
            <Input inputMode="numeric" maxLength={5} placeholder="例：1234" />
          </Form.Item>
        </Col>
        <Col xs={24} sm={8}>
          <Form.Item
            name={[...prefix, 'subNo']}
            label="分號"
            rules={[{ pattern: /^\d{0,3}$/, message: '分號為 1 到 3 位數字' }]}
            extra="沒有分號請留空"
          >
            <Input inputMode="numeric" maxLength={3} placeholder="例：0" />
          </Form.Item>
        </Col>
      </Row>
    </>
  );
}

/** 座標要成對：另一格有填、這格沒填時擋下。 */
const pairedWith =
  (other: (string | number)[], message: string) =>
  ({ getFieldValue }: { getFieldValue: (name: (string | number)[]) => unknown }) => ({
    validator(_: unknown, value: unknown) {
      return value == null && getFieldValue(other) != null ? Promise.reject(new Error(message)) : Promise.resolve();
    },
  });

/** 建立物件時的「建號」區塊：鍵（必填）加選填的座標。欄位路徑是 ['anchor', ...]。 */
export function AnchorSection({ form }: { form: FormInstance }) {
  return (
    <>
      <Typography.Title level={5}>建號</Typography.Title>
      <AnchorKeyFields form={form} prefix={['anchor', 'key']} />
      <Row gutter={16}>
        <Col xs={24} sm={8}>
          <Form.Item
            name={['anchor', 'latitude']}
            label="緯度（選填）"
            dependencies={[['anchor', 'longitude']]}
            rules={[pairedWith(['anchor', 'longitude'], '座標請同時填緯度與經度')]}
          >
            <InputNumber min={-90} max={90} step={0.0001} className={styles.fullWidth} placeholder="例：25.0330" />
          </Form.Item>
        </Col>
        <Col xs={24} sm={8}>
          <Form.Item
            name={['anchor', 'longitude']}
            label="經度（選填）"
            dependencies={[['anchor', 'latitude']]}
            rules={[pairedWith(['anchor', 'latitude'], '座標請同時填緯度與經度')]}
          >
            <InputNumber min={-180} max={180} step={0.0001} className={styles.fullWidth} placeholder="例：121.5654" />
          </Form.Item>
        </Col>
      </Row>
    </>
  );
}
