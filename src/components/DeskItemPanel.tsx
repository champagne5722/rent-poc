'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Descriptions, Flex, Form, Input, Popconfirm, Radio, Select, Table, Tag, Typography } from 'antd';
import { LeftOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { statutoryTitle } from '@/lib/labels';
import { queueTypeLabel, resolutionLabel, stateLabel } from '@/lib/practice-entities/display';
import type { DeskCheck, ReviewDetail } from '@/lib/practice-entities/desk';
import type { EvidenceMeta } from '@/lib/practice-entities/evidence';
import { NOTE_MAX, QUERY_SOURCE_MAX } from '@/lib/practice-entities/rules';

// 審核項目的核對畫面（MIL-109）。業別核對：查商工登記與 resim 後，登錄營業項目、登記狀態與結果（ADR-0017 決議 10）。
// 統編認領：同時列出登錄者與認領方，由營運者判定歸屬。證據檔在這裡開啟，每次開啟都寫稽核事件。
// 系統不接任何外部查詢：商工登記與 resim 都是營運者人工查、人工登錄。

const CHANNEL_OPTIONS = [
  { value: 'gcis_manual', label: '商工登記（人工查詢）' },
  { value: 'resim_manual', label: 'resim（人工查詢）' },
  { value: 'document_review', label: '文件核對' },
];
const CHANNEL_LABEL: Record<string, string> = Object.fromEntries(CHANNEL_OPTIONS.map((o) => [o.value, o.label]));
const RESULT_OPTIONS = [
  { value: 'match', label: '相符' },
  { value: 'mismatch', label: '不符' },
  { value: 'not_found', label: '查無資料' },
  { value: 'revoked', label: '已廢止' },
];
const ENTITY_TYPE_LABEL = { company: '公司', firm: '商號' } as const;

const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false }) : '—');
const formatSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

interface Shortfall {
  code: string;
  kind: string;
  message: string;
  missing?: string;
}

interface CheckFormValues {
  channel: string;
  querySource: string;
  businessItemCodes: string[];
  registrationStatus: string;
  result: 'match' | 'mismatch' | 'not_found' | 'revoked';
  note: string;
}

interface PostResult {
  ok: boolean;
  status: number;
  body: { error?: string; field?: string; reasons?: Shortfall[] };
}

async function post(url: string, body: unknown): Promise<PostResult> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: response.ok, status: response.status, body: ((await response.json().catch(() => ({}))) as PostResult['body']) ?? {} };
}

function EvidenceList({ evidence }: { evidence: EvidenceMeta[] }) {
  return (
    <Table<EvidenceMeta>
      size="middle"
      rowKey="id"
      pagination={false}
      dataSource={evidence}
      locale={{ emptyText: '沒有證據檔。' }}
      columns={[
        { title: '檔名', dataIndex: 'fileName' },
        { title: '大小', dataIndex: 'byteSize', width: 90, align: 'right', render: formatSize },
        { title: '上傳時間', dataIndex: 'uploadedAt', width: 180, render: formatDate },
        {
          title: '操作',
          key: 'action',
          width: 110,
          render: (_v, file) =>
            file.state === 'stored' ? (
              // 開啟會寫稽核事件。新分頁開，不離開核對畫面
              <a href={`/api/desk/evidence/${file.id}`} target="_blank" rel="noreferrer">
                開啟
              </a>
            ) : (
              <Tag>已刪除</Tag>
            ),
        },
      ]}
    />
  );
}

function ChecksTable({ checks, kindOf }: { checks: DeskCheck[]; kindOf: (licenseId: string) => string }) {
  if (checks.length === 0) return null;
  return (
    <Flex vertical gap="small">
      <Typography.Title level={5} style={{ margin: 0 }}>
        歷次核對
      </Typography.Title>
      <Table<DeskCheck>
        size="middle"
        rowKey="id"
        pagination={false}
        dataSource={checks}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '時間', dataIndex: 'checkedAt', width: 180, render: formatDate },
          { title: '業別', dataIndex: 'licenseId', render: (id: string) => kindOf(id) },
          { title: '管道', dataIndex: 'channel', render: (c: string) => CHANNEL_LABEL[c] ?? c },
          { title: '查詢頁別', dataIndex: 'querySource' },
          { title: '結果', dataIndex: 'result', width: 100, render: (r: string) => resolutionLabel(r) },
          { title: '判定理由', dataIndex: 'note', render: (n: string) => n || '—' },
        ]}
      />
    </Flex>
  );
}

function DeskItemPanelInner({ itemId }: { itemId: string }) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shortfalls, setShortfalls] = useState<Shortfall[] | null>(null);
  const [checkForm] = Form.useForm<CheckFormValues>();
  const [claimForm] = Form.useForm<{ decision: 'keep_registrant' | 'to_claimant'; note: string }>();
  const result = Form.useWatch('result', checkForm);

  const load = useCallback(async (): Promise<{ detail: ReviewDetail } | { error: string }> => {
    try {
      const response = await fetch(`/api/desk/items/${itemId}`);
      if (response.status === 403) return { error: '只有平台營運者身分能開啟審核台。請從右上角切換身分。' };
      if (response.status === 404) return { error: '找不到這個審核項目。' };
      if (!response.ok) throw new Error(String(response.status));
      return { detail: ((await response.json()) as { data: ReviewDetail }).data };
    } catch {
      return { error: '審核項目載入失敗，請重新整理。' };
    }
  }, [itemId]);

  const apply = useCallback((loaded: { detail: ReviewDetail } | { error: string }) => {
    if ('detail' in loaded) {
      setDetail(loaded.detail);
      setError(null);
    } else {
      setError(loaded.error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().then((loaded) => {
      if (!cancelled) apply(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [apply, load]);

  async function submit(url: string, body: unknown, setFieldError: (field: string, errorText: string) => void, success: string) {
    setBusy(true);
    setShortfalls(null);
    try {
      const response = await post(url, body);
      if (response.ok) {
        message.success(success);
        router.push('/desk');
        return;
      }
      if (response.status === 422 && response.body.reasons) {
        setShortfalls(response.body.reasons);
      } else if (response.body.field) {
        setFieldError(response.body.field, response.body.error ?? '欄位有誤');
      } else {
        message.error(response.body.error ?? '操作失敗，請稍後再試');
        if (response.status === 409) apply(await load());
      }
    } catch {
      message.error('網路發生問題，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Alert type="error" showIcon title={error} />;
  if (!detail) return <Typography.Text type="secondary">載入中…</Typography.Text>;

  const { item, entity, license, claim } = detail;
  const open = item.status === 'open';

  return (
    <Flex vertical gap="large" style={{ maxWidth: 960 }}>
      <Flex align="center" gap="middle" wrap>
        <Link href="/desk">
          <LeftOutlined aria-hidden /> 回審核台
        </Link>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {queueTypeLabel(item.type)}
        </Typography.Title>
        {!open && <Tag>已結案：{resolutionLabel(item.resolution)}</Tag>}
      </Flex>

      {entity && (
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2 }}
          items={[
            { key: 'name', label: '執業主體', children: entity.name },
            { key: 'taxId', label: '統一編號', children: entity.taxId },
            { key: 'type', label: '組織型態', children: ENTITY_TYPE_LABEL[entity.entityType] },
            { key: 'org', label: '登錄者組織', children: entity.orgName },
            { key: 'items', label: '營業項目', children: entity.businessItemCodes.length > 0 ? entity.businessItemCodes.join('、') : '尚未登錄' },
            {
              key: 'reg',
              label: '登記狀態',
              children: entity.registrationStatus ? `${entity.registrationStatus}（${formatDate(entity.registrationCheckedAt)}）` : '尚未登錄',
            },
            ...(license
              ? [
                  { key: 'kind', label: '業別', children: statutoryTitle(license.kind) },
                  { key: 'permit', label: '許可或登記證字號', children: license.permitNo ?? '—' },
                  { key: 'state', label: '驗證狀態', children: stateLabel(license.state) },
                  { key: 'submitted', label: '送件時間', children: formatDate(license.submittedAt) },
                ]
              : []),
          ]}
        />
      )}

      {claim && (
        <Flex vertical gap="small">
          <Alert
            type="info"
            showIcon
            title="另一個組織認領了同一個統一編號"
            description="請對照兩邊送的證明文件，判定這個統編歸屬哪個組織。判定結果只通知認領方，不通知原登錄者。"
          />
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2 }}
            title="認領方"
            items={[
              { key: 'org', label: '組織', children: claim.claimantOrgName ?? '—' },
              { key: 'name', label: '送出的名稱', children: claim.name },
              { key: 'type', label: '組織型態', children: ENTITY_TYPE_LABEL[claim.entityType] },
              { key: 'kinds', label: '要登錄的業別', children: claim.kinds.map((k) => statutoryTitle(k)).join('、') },
              ...Object.entries(claim.submissions).map(([kind, sub]) => ({
                key: `sub-${kind}`,
                label: `${statutoryTitle(kind as 'management')}的字號`,
                children: sub.permitNo,
              })),
              ...(claim.resolutionNote ? [{ key: 'note', label: '判定理由', children: claim.resolutionNote }] : []),
            ]}
          />
          {entity && entity.licenses.length > 0 && (
            <Descriptions
              size="small"
              column={{ xs: 1, sm: 2 }}
              title="原登錄者的業別"
              items={entity.licenses.map((l) => ({
                key: l.id,
                label: statutoryTitle(l.kind),
                children: `${stateLabel(l.state)}，字號 ${l.permitNo ?? '尚未送件'}`,
              }))}
            />
          )}
        </Flex>
      )}

      <Flex vertical gap="small">
        <Typography.Title level={5} style={{ margin: 0 }}>
          證據檔
        </Typography.Title>
        <EvidenceList evidence={detail.evidence} />
      </Flex>

      <ChecksTable
        checks={detail.checks}
        kindOf={(licenseId) => {
          const kind = entity?.licenses.find((l) => l.id === licenseId)?.kind;
          return kind ? statutoryTitle(kind) : '—';
        }}
      />

      {open && item.type === 'license' && license && (
        <Form<CheckFormValues>
          form={checkForm}
          layout="vertical"
          requiredMark={false}
          onValuesChange={() => setShortfalls(null)}
          initialValues={{ channel: 'gcis_manual', registrationStatus: '核准設立', result: 'match', businessItemCodes: entity?.businessItemCodes ?? [] }}
          onFinish={(values) =>
            void submit(
              `/api/desk/items/${itemId}/check`,
              { ...values, note: values.note ?? '' },
              (field, errorText) => checkForm.setFields([{ name: field as keyof CheckFormValues, errors: [errorText] }]),
              values.result === 'match' ? '已登錄核對結果，業別轉為已驗證。' : '已登錄核對結果，通知執業主體補件。',
            )
          }
        >
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            登錄核對結果
          </Typography.Title>
          <Flex gap="small" wrap align="flex-start">
            <Form.Item label="核對管道" name="channel" style={{ flex: '1 1 240px' }} rules={[{ required: true }]}>
              <Select options={CHANNEL_OPTIONS} />
            </Form.Item>
            <Form.Item
              label="查詢的頁別"
              name="querySource"
              style={{ flex: '2 1 320px' }}
              rules={[
                { required: true, whitespace: true, message: '請填查詢的頁別，例如「商工登記公示資料查詢」' },
                { max: QUERY_SOURCE_MAX, message: `不得超過 ${QUERY_SOURCE_MAX} 字` },
              ]}
            >
              <Input autoComplete="off" />
            </Form.Item>
          </Flex>
          <Flex gap="small" wrap align="flex-start">
            <Form.Item
              label="營業項目代碼"
              name="businessItemCodes"
              style={{ flex: '2 1 320px' }}
              extra="商工登記上的全部營業項目。代管需要 H706011，包租需要 H706021，經紀需要 H704031。"
            >
              <Select mode="tags" tokenSeparators={[',', '，', ' ']} placeholder="輸入代碼後按 Enter" open={false} />
            </Form.Item>
            <Form.Item label="登記狀態" name="registrationStatus" style={{ flex: '1 1 200px' }} extra="不是「核准設立」時，全部業別轉為已失效。">
              <Input autoComplete="off" />
            </Form.Item>
          </Flex>
          <Form.Item label="核對結果" name="result" rules={[{ required: true }]}>
            <Radio.Group options={RESULT_OPTIONS} />
          </Form.Item>
          <Form.Item
            label={result === 'match' ? '備註（選填）' : '判定理由'}
            name="note"
            extra={result === 'match' ? undefined : '執業主體會在登錄頁看到這段文字，並依它補件。'}
            rules={result === 'match' ? [{ max: NOTE_MAX }] : [{ required: true, whitespace: true, message: '請寫判定理由' }, { max: NOTE_MAX }]}
          >
            <Input.TextArea rows={3} maxLength={NOTE_MAX} showCount />
          </Form.Item>
          {shortfalls && (
            <Alert
              type="error"
              showIcon
              title="不符合業別規則，不能判定相符"
              description={
                <ul>
                  {shortfalls.map((reason) => (
                    <li key={`${reason.code}-${reason.kind}`}>{reason.message}</li>
                  ))}
                </ul>
              }
            />
          )}
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={busy}>
              登錄核對結果
            </Button>
          </Form.Item>
        </Form>
      )}

      {open && item.type === 'entity_claim' && claim && (
        <Form<{ decision: 'keep_registrant' | 'to_claimant'; note: string }>
          form={claimForm}
          layout="vertical"
          requiredMark={false}
          initialValues={{ decision: 'keep_registrant' }}
          onFinish={(values) =>
            void submit(
              `/api/desk/items/${itemId}/claim`,
              values,
              (field, errorText) => claimForm.setFields([{ name: field as 'note', errors: [errorText] }]),
              '已判定歸屬。',
            )
          }
        >
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            判定歸屬
          </Typography.Title>
          <Form.Item label="判定結果" name="decision" rules={[{ required: true }]}>
            <Radio.Group
              options={[
                { value: 'keep_registrant', label: '維持原登錄者（認領方需要補件）' },
                { value: 'to_claimant', label: '改歸認領方（原登錄者的待核對項目作廢）' },
              ]}
            />
          </Form.Item>
          <Form.Item label="判定理由" name="note" extra="認領方會看到這段文字。" rules={[{ required: true, whitespace: true, message: '請寫判定理由' }, { max: NOTE_MAX }]}>
            <Input.TextArea rows={3} maxLength={NOTE_MAX} showCount />
          </Form.Item>
          <Form.Item>
            <Popconfirm title="確定送出判定？" description="判定結果送出後不能更改。" okText="送出" cancelText="取消" onConfirm={() => claimForm.submit()}>
              <Button type="primary" loading={busy}>
                送出判定
              </Button>
            </Popconfirm>
          </Form.Item>
        </Form>
      )}
    </Flex>
  );
}

// 沿用成員管理頁的做法：頁面自己包 AntApp，message 才吃得到主題
export default function DeskItemPanel({ itemId }: { itemId: string }) {
  return (
    <AntApp>
      <DeskItemPanelInner itemId={itemId} />
    </AntApp>
  );
}
