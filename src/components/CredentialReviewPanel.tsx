'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Descriptions, Flex, Form, Input, Radio, Select, Table, Tag, Typography } from 'antd';
import { LeftOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { practitionerTitle } from '@/lib/labels';
import { queueTypeLabel, resolutionLabel, stateLabel } from '@/lib/practice-entities/display';
import type { EvidenceMeta } from '@/lib/practice-entities/evidence';
import { NOTE_MAX, QUERY_SOURCE_MAX } from '@/lib/practice-entities/rules';
import type { CredentialCheck, CredentialReview } from '@/lib/practitioners/desk';
import { formatCertificateNumber } from '@/lib/practitioners/rules';

// 證書、任職與同意書的核對畫面（MIL-111，ADR-0017 決議 7、10）。營運者在 resim 查證書與任職後登錄結果。
// 證書相符時登錄 resim 查到的效期（以它為準），影本在相符後刪除。
// 任職相符前，系統先判定專任：別家已有已驗證的管理人員任職就擋下。兩家都待驗證時，這裡列出同一證號的其他任職，
// 由營運者依 resim 任職查詢判定哪一家相符。同意書相符後，任職標示「經所屬業者同意」，同意書保留。
// 系統不接任何外部查詢：resim 是營運者人工查、人工登錄，也不繞過圖形驗證碼。

const CHANNEL_OPTIONS = {
  certificate: [{ value: 'resim_manual', label: 'resim 證書查詢（人工查詢）' }],
  employment: [{ value: 'resim_manual', label: 'resim 任職查詢（人工查詢）' }],
  consent: [{ value: 'document_review', label: '文件核對' }],
} as const;
const CHANNEL_LABEL: Record<string, string> = {
  gcis_manual: '商工登記（人工查詢）',
  resim_manual: 'resim（人工查詢）',
  document_review: '文件核對',
};
const RESULT_OPTIONS = [
  { value: 'match', label: '相符' },
  { value: 'mismatch', label: '不符' },
  { value: 'not_found', label: '查無資料' },
  { value: 'revoked', label: '已廢止' },
];
const DEFAULT_SOURCE = { certificate: 'resim 證書查詢', employment: 'resim 任職查詢', consent: '所屬業者同意書' } as const;

const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false }) : '—');
const formatSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const LAYER_LABEL: Record<string, string> = { practitioner: '證書', employment: '任職' };

interface FormValues {
  channel: string;
  querySource: string;
  result: 'match' | 'mismatch' | 'not_found' | 'revoked';
  validUntil?: string;
  note: string;
}

function CredentialReviewInner({ itemId }: { itemId: string }) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [review, setReview] = useState<CredentialReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [form] = Form.useForm<FormValues>();
  const result = Form.useWatch('result', form);

  const load = useCallback(async (): Promise<{ review: CredentialReview } | { error: string }> => {
    try {
      const response = await fetch(`/api/desk/credentials/${itemId}`);
      if (response.status === 403) return { error: '只有平台營運者身分能開啟審核台。請從右上角切換身分。' };
      if (response.status === 404) return { error: '找不到這個審核項目。' };
      if (!response.ok) throw new Error(String(response.status));
      return { review: ((await response.json()) as { data: CredentialReview }).data };
    } catch {
      return { error: '審核項目載入失敗，請重新整理。' };
    }
  }, [itemId]);

  useEffect(() => {
    let cancelled = false;
    void load().then((loaded) => {
      if (cancelled) return;
      if ('review' in loaded) {
        setReview(loaded.review);
        setError(null);
      } else {
        setError(loaded.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function submit(values: FormValues) {
    if (!review) return;
    setBusy(true);
    setBlocked(null);
    try {
      const response = await fetch(`/api/desk/items/${itemId}/credential-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const body = ((await response.json().catch(() => ({}))) as { error?: string; field?: string; code?: string; data?: { warnings?: string[] } }) ?? {};
      if (response.ok) {
        message.success(body.data?.warnings?.includes('consent_missing') ? '已登錄。注意：所屬業者的同意書還沒核對。' : '已登錄核對結果。');
        router.push('/desk');
        return;
      }
      if (body.code === 'exclusivity_blocked' || body.code === 'certificate_taken') {
        setBlocked(body.error ?? '無法判定相符');
      } else if (body.field) {
        form.setFields([{ name: body.field as keyof FormValues, errors: [body.error ?? '欄位有誤'] }]);
      } else {
        message.error(body.error ?? '操作失敗，請稍後再試');
        if (response.status === 409) {
          const loaded = await load();
          if ('review' in loaded) setReview(loaded.review);
        }
      }
    } catch {
      message.error('網路發生問題，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Alert type="error" showIcon title={error} />;
  if (!review) return <Typography.Text type="secondary">載入中…</Typography.Text>;

  const { item, practitioner, employment, competing, checks, evidence } = review;
  const open = item.status === 'open';
  const type = item.type;
  const verifiedElsewhere = competing.some((c) => c.state === 'verified');

  return (
    <Flex vertical gap="large" style={{ maxWidth: 960 }}>
      <Flex align="center" gap="middle" wrap>
        <Link href="/desk">
          <LeftOutlined aria-hidden /> 回審核台
        </Link>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {queueTypeLabel(type)}
        </Typography.Title>
        {!open && <Tag>已結案：{resolutionLabel(item.resolution)}</Tag>}
      </Flex>

      {practitioner && (
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2 }}
          items={[
            { key: 'name', label: '執業人員', children: practitioner.partyName },
            { key: 'kind', label: '證書種類', children: practitionerTitle(practitioner.kind) },
            { key: 'number', label: '證號', children: formatCertificateNumber(practitioner.number) },
            { key: 'issued', label: '發證日', children: practitioner.issuedOn },
            { key: 'valid', label: '送件的效期', children: practitioner.validUntil },
            { key: 'state', label: '證書驗證狀態', children: stateLabel(practitioner.state) },
            ...(employment
              ? [
                  { key: 'entity', label: '任職的執業主體', children: employment.entityName },
                  { key: 'started', label: '到職日', children: employment.startedOn },
                  { key: 'estate', label: '任職驗證狀態', children: stateLabel(employment.state) },
                  { key: 'consent', label: '所屬業者同意書', children: employment.consentRequired ? (employment.consentVerifiedAt && !employment.consentEndedAt ? '已核對' : '尚未核對') : '不需要' },
                ]
              : []),
          ]}
        />
      )}

      {type === 'employment' && competing.length > 0 && (
        <Flex vertical gap="small">
          <Alert
            type={verifiedElsewhere && practitioner?.kind === 'rental_housing_manager' ? 'warning' : 'info'}
            showIcon
            title={
              verifiedElsewhere && practitioner?.kind === 'rental_housing_manager'
                ? '同一證號在別的執業主體已有已驗證的專任任職，不能判定這一筆相符，除非那一筆先結束。'
                : '同一證號在別的執業主體也有任職。請依 resim 任職查詢判定哪一家相符。'
            }
          />
          <Table<CredentialReview['competing'][number]>
            size="middle"
            rowKey="id"
            pagination={false}
            dataSource={competing}
            columns={[
              { title: '執業主體', dataIndex: 'entityName' },
              { title: '登錄者', dataIndex: 'partyName' },
              { title: '任職狀態', dataIndex: 'state', width: 100, render: (state: CredentialReview['competing'][number]['state']) => stateLabel(state) },
              { title: '到職日', dataIndex: 'startedOn', width: 120 },
              { title: '同意書', key: 'consent', width: 120, render: (_v, c) => (c.consentRequired ? (c.consentedByEntity ? '經所屬業者同意' : '尚未核對') : '不需要') },
            ]}
          />
        </Flex>
      )}

      {(type === 'certificate' || type === 'consent') && (
        <Flex vertical gap="small">
          <Typography.Title level={5} style={{ margin: 0 }}>
            {type === 'certificate' ? '證書影本' : '所屬業者同意書'}
          </Typography.Title>
          <Table<EvidenceMeta>
            size="middle"
            rowKey="id"
            pagination={false}
            dataSource={evidence}
            locale={{ emptyText: '沒有檔案。' }}
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
        </Flex>
      )}

      {checks.length > 0 && (
        <Flex vertical gap="small">
          <Typography.Title level={5} style={{ margin: 0 }}>
            歷次核對
          </Typography.Title>
          <Table<CredentialCheck>
            size="middle"
            rowKey="id"
            pagination={false}
            dataSource={checks}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: '時間', dataIndex: 'checkedAt', width: 180, render: formatDate },
              {
                title: '對象',
                key: 'layer',
                width: 90,
                render: (_v, c) => (c.observed.document === 'consent_letter' ? '同意書' : (LAYER_LABEL[c.subjectType] ?? c.subjectType)),
              },
              { title: '管道', dataIndex: 'channel', render: (c: string) => CHANNEL_LABEL[c] ?? c },
              { title: '查詢頁別', dataIndex: 'querySource' },
              { title: '結果', dataIndex: 'result', width: 100, render: (r: string) => resolutionLabel(r) },
              { title: '判定理由', dataIndex: 'note', render: (n: string) => n || '—' },
            ]}
          />
        </Flex>
      )}

      {open && (
        <Form<FormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{
            channel: CHANNEL_OPTIONS[type][0].value,
            querySource: DEFAULT_SOURCE[type],
            result: 'match',
            validUntil: type === 'certificate' ? practitioner?.validUntil : undefined,
          }}
          onFinish={(values) => void submit(values)}
        >
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            登錄核對結果
          </Typography.Title>
          {blocked && <Alert type="error" showIcon title={blocked} style={{ marginBottom: 16 }} />}
          <Flex gap="small" wrap align="flex-start">
            <Form.Item label="核對管道" name="channel" style={{ flex: '1 1 240px' }} rules={[{ required: true, message: '請選擇核對管道' }]}>
              <Select options={[...CHANNEL_OPTIONS[type]]} />
            </Form.Item>
            <Form.Item
              label="查詢的頁別"
              name="querySource"
              style={{ flex: '2 1 320px' }}
              rules={[{ required: true, whitespace: true, message: '請填查詢的頁別' }, { max: QUERY_SOURCE_MAX, message: `不得超過 ${QUERY_SOURCE_MAX} 字` }]}
            >
              <Input autoComplete="off" />
            </Form.Item>
          </Flex>
          <Form.Item label="核對結果" name="result" rules={[{ required: true, message: '請選擇核對結果' }]}>
            <Radio.Group options={RESULT_OPTIONS} optionType="button" />
          </Form.Item>
          {result === 'match' && type === 'certificate' && (
            <Form.Item
              label="效期（resim 查到的）"
              name="validUntil"
              extra="以 resim 為準。送件的效期只是預填，不一致時請改成 resim 的日期。"
              rules={[{ required: true, message: '相符時請登錄 resim 查到的效期' }]}
              style={{ maxWidth: 240 }}
            >
              <Input type="date" />
            </Form.Item>
          )}
          {result === 'match' && type === 'consent' && (
            <Form.Item label="同意書有效期限（選填）" name="validUntil" extra="同意書沒有載明期限時留空。" style={{ maxWidth: 240 }}>
              <Input type="date" />
            </Form.Item>
          )}
          <Form.Item
            label={result === 'match' ? '備註（選填）' : '判定理由'}
            name="note"
            extra={result === 'match' ? undefined : '執業人員會看到這段文字並據此補件。'}
            rules={[{ required: result !== 'match', whitespace: true, message: '核對結果不是相符時，請寫判定理由' }, { max: NOTE_MAX, message: `不得超過 ${NOTE_MAX} 字` }]}
          >
            <Input.TextArea rows={3} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>
            登錄
          </Button>
        </Form>
      )}
    </Flex>
  );
}

export default function CredentialReviewPanel({ itemId }: { itemId: string }) {
  return (
    <AntApp>
      <CredentialReviewInner itemId={itemId} />
    </AntApp>
  );
}
