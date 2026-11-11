'use client';

import { useState } from 'react';
import { Alert, App as AntApp, Button, Card, Col, DatePicker, Descriptions, Form, Input, Radio, Row, Select } from 'antd';
import dayjs from 'dayjs';
import { useRouter } from 'next/navigation';
import EvidenceCard from '@/components/desk/EvidenceCard';
import styles from '@/components/desk/desk.module.css';
import DetailPage from '@/components/page/DetailPage';
import ListTable from '@/components/page/ListTable';
import NextStep from '@/components/page/NextStep';
import StatusTag from '@/components/StatusTag';
import { practitionerTitle } from '@/lib/labels';
import { formatTaipeiDateTime } from '@/lib/ownership/format';
import { deskNextStep } from '@/lib/practice-entities/desk-next-step';
import { formatWaiting, queueTypeLabel, resolutionLabel, stateLabel } from '@/lib/practice-entities/display';
import { NOTE_MAX, QUERY_SOURCE_MAX } from '@/lib/practice-entities/rules';
import type { CredentialCheck, CredentialReview } from '@/lib/practitioners/desk';
import { formatCertificateNumber } from '@/lib/practitioners/rules';

// 證書、任職與同意書的核對畫面（MIL-111、MIL-180，ADR-0017 決議 7、10）。營運者在 resim 查證書與任職後登錄結果。
// 證書相符時登錄 resim 查到的效期（以它為準），影本在相符後刪除。
// 任職相符前，系統先判定專任：別家已有已驗證的管理人員任職就擋下。兩家都待驗證時，這裡列出同一證號的其他任職，
// 由營運者依 resim 任職查詢判定哪一家相符。同意書相符後，任職標示「經所屬業者同意」，同意書保留。
// 系統不接任何外部查詢：resim 是營運者人工查、人工登錄，也不繞過圖形驗證碼。
// 資料由 server component 載入（src/app/desk/items/[id]/page.tsx）。

// 效期欄用 antd DatePicker，表單裡的值仍是 YYYY-MM-DD 字串（空值是空字串），送出的格式與原生日期欄相同。
const DATE_FORMAT = 'YYYY-MM-DD';
const dateField = {
  getValueProps: (value?: string) => ({ value: value ? dayjs(value, DATE_FORMAT) : null }),
  normalize: (value: dayjs.Dayjs | null) => (value ? value.format(DATE_FORMAT) : ''),
};

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
const LAYER_LABEL: Record<string, string> = { practitioner: '證書', employment: '任職' };

interface FormValues {
  channel: string;
  querySource: string;
  result: 'match' | 'mismatch' | 'not_found' | 'revoked';
  validUntil?: string;
  note: string;
}

type Competing = CredentialReview['competing'][number];

function Inner({ review, nowIso }: { review: CredentialReview; nowIso: string }) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [form] = Form.useForm<FormValues>();
  const result = Form.useWatch('result', form);

  const { item, practitioner, employment, competing, checks, evidence } = review;
  const open = item.status === 'open';
  const itemId = item.id;
  const type = item.type as keyof typeof CHANNEL_OPTIONS;
  const verifiedElsewhere = competing.some((c) => c.state === 'verified');
  const step = deskNextStep(item);

  async function submit(values: FormValues) {
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
        message.error(`${body.error ?? '操作失敗'}。請稍後再試。`);
        // 項目已被別人處理時，畫面更新為最新狀態
        if (response.status === 409) router.refresh();
      }
    } catch {
      message.error('網路發生問題。請檢查連線後再試一次。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailPage
      header={{ title: queueTypeLabel(item.type), tag: <StatusTag kind="reviewItem" value={item.status} />, back: { href: '/desk', label: '返回審核台' } }}
      notices={
        type === 'employment' && competing.length > 0 ? (
          <Alert
            type={verifiedElsewhere && practitioner?.kind === 'rental_housing_manager' ? 'warning' : 'info'}
            showIcon
            title={
              verifiedElsewhere && practitioner?.kind === 'rental_housing_manager'
                ? '同一證號在別的執業主體已有已驗證的專任任職，不能判定這一筆相符，除非那一筆先結束。'
                : '同一證號在別的執業主體也有任職。請依 resim 任職查詢判定哪一家相符。'
            }
          />
        ) : undefined
      }
      nextStep={<NextStep headline={step.headline} owner={step.owner} detail={step.detail} tone={step.tone} />}
      aside={
        <>
          <Card size="small" title="項目屬性">
            <Descriptions
              size="small"
              column={1}
              items={[
                { key: 'type', label: '類型', children: queueTypeLabel(item.type) },
                { key: 'created', label: '排進審核台', children: formatTaipeiDateTime(item.createdAt) },
                ...(item.resolvedAt
                  ? [
                      { key: 'resolved', label: '結案時間', children: formatTaipeiDateTime(item.resolvedAt) },
                      { key: 'resolution', label: '結果', children: resolutionLabel(item.resolution) },
                    ]
                  : [{ key: 'waiting', label: '等待時間', children: formatWaiting(new Date(nowIso).getTime() - new Date(item.createdAt).getTime()) }]),
              ]}
            />
          </Card>
          {practitioner && (
            <Card size="small" title="執業人員">
              <Descriptions
                size="small"
                column={1}
                items={[
                  { key: 'name', label: '姓名', children: practitioner.partyName },
                  { key: 'kind', label: '證書種類', children: practitionerTitle(practitioner.kind) },
                  { key: 'number', label: '證號', children: formatCertificateNumber(practitioner.number) },
                  { key: 'issued', label: '發證日', children: practitioner.issuedOn },
                  { key: 'valid', label: '送件的效期', children: practitioner.validUntil },
                  { key: 'state', label: '證書驗證狀態', children: stateLabel(practitioner.state) },
                ]}
              />
            </Card>
          )}
          {employment && (
            <Card size="small" title="任職">
              <Descriptions
                size="small"
                column={1}
                items={[
                  { key: 'entity', label: '任職的執業主體', children: employment.entityName },
                  { key: 'started', label: '到職日', children: employment.startedOn },
                  { key: 'estate', label: '任職驗證狀態', children: stateLabel(employment.state) },
                  {
                    key: 'consent',
                    label: '所屬業者同意書',
                    children: employment.consentRequired ? (employment.consentVerifiedAt && !employment.consentEndedAt ? '已核對' : '尚未核對') : '不需要',
                  },
                ]}
              />
            </Card>
          )}
        </>
      }
    >
      {type === 'employment' && competing.length > 0 && (
        <Card size="small" title="同一證號的其他任職">
          <ListTable<Competing>
            table={{
              rowKey: 'id',
              dataSource: competing,
              scroll: { x: 'max-content' },
              columns: [
                { title: '執業主體', dataIndex: 'entityName' },
                { title: '登錄者', dataIndex: 'partyName' },
                { title: '任職狀態', dataIndex: 'state', width: 100, render: (state: Competing['state']) => stateLabel(state) },
                { title: '到職日', dataIndex: 'startedOn', width: 120 },
                { title: '同意書', key: 'consent', width: 120, render: (_v, c) => (c.consentRequired ? (c.consentedByEntity ? '經所屬業者同意' : '尚未核對') : '不需要') },
              ],
            }}
            emptyNode={null}
          />
        </Card>
      )}

      {(type === 'certificate' || type === 'consent') && (
        <EvidenceCard title={type === 'certificate' ? '證書影本' : '所屬業者同意書'} evidence={evidence} emptyText="沒有檔案。" />
      )}

      {checks.length > 0 && (
        <Card size="small" title="歷次核對">
          <ListTable<CredentialCheck>
            table={{
              rowKey: 'id',
              dataSource: checks,
              scroll: { x: 'max-content' },
              columns: [
                { title: '時間', dataIndex: 'checkedAt', width: 160, render: formatTaipeiDateTime },
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
              ],
            }}
            emptyNode={null}
          />
        </Card>
      )}

      {open && (
        <Card size="small" title="登錄核對結果">
          <Form<FormValues>
            form={form}
            layout="vertical"
            requiredMark={false}
            disabled={busy}
            initialValues={{
              channel: CHANNEL_OPTIONS[type][0].value,
              querySource: DEFAULT_SOURCE[type],
              result: 'match',
              validUntil: type === 'certificate' ? practitioner?.validUntil : undefined,
            }}
            onFinish={(values) => void submit(values)}
          >
              {blocked && (
                <Form.Item>
                  <Alert type="error" showIcon title={blocked} />
                </Form.Item>
              )}
              <Row gutter={16}>
                <Col xs={24} md={10}>
                  <Form.Item label="核對管道" name="channel" rules={[{ required: true, message: '請選擇核對管道' }]}>
                    <Select options={[...CHANNEL_OPTIONS[type]]} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={14}>
                  <Form.Item
                    label="查詢的頁別"
                    name="querySource"
                    rules={[{ required: true, whitespace: true, message: '請填查詢的頁別' }, { max: QUERY_SOURCE_MAX, message: `不得超過 ${QUERY_SOURCE_MAX} 字` }]}
                  >
                    <Input autoComplete="off" />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item label="核對結果" name="result" rules={[{ required: true, message: '請選擇核對結果' }]}>
                <Radio.Group options={RESULT_OPTIONS} optionType="button" />
              </Form.Item>
              {result === 'match' && type === 'certificate' && (
                <Form.Item
                  label="效期（resim 查到的）"
                  name="validUntil"
                  extra="以 resim 為準。送件的效期只是預填，不一致時請改成 resim 的日期。"
                  rules={[{ required: true, message: '相符時請登錄 resim 查到的效期' }]}
                  className={styles.fieldDate}
                  {...dateField}
                >
                  <DatePicker className={styles.fullWidth} />
                </Form.Item>
              )}
              {result === 'match' && type === 'consent' && (
                <Form.Item label="同意書有效期限（選填）" name="validUntil" extra="同意書沒有載明期限時留空。" className={styles.fieldDate} {...dateField}>
                  <DatePicker className={styles.fullWidth} />
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
              <Form.Item>
                <Button type="primary" htmlType="submit" loading={busy}>
                  登錄
                </Button>
              </Form.Item>
          </Form>
        </Card>
      )}
    </DetailPage>
  );
}

export default function CredentialReviewPanel({ review, nowIso }: { review: CredentialReview; nowIso: string }) {
  return (
    <AntApp>
      <Inner review={review} nowIso={nowIso} />
    </AntApp>
  );
}
