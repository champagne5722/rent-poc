'use client';

import { useState } from 'react';
import { Alert, App as AntApp, Button, Card, Col, Descriptions, Flex, Form, Input, Popconfirm, Radio, Row, Select } from 'antd';
import { useRouter } from 'next/navigation';
import EvidenceCard from '@/components/desk/EvidenceCard';
import styles from '@/components/desk/desk.module.css';
import DetailPage from '@/components/page/DetailPage';
import ListTable from '@/components/page/ListTable';
import NextStep from '@/components/page/NextStep';
import StatusTag from '@/components/StatusTag';
import { statutoryTitle } from '@/lib/labels';
import { formatTaipeiDateTime } from '@/lib/ownership/format';
import { deskNextStep } from '@/lib/practice-entities/desk-next-step';
import { formatWaiting, queueTypeLabel, resolutionLabel, stateLabel } from '@/lib/practice-entities/display';
import type { DeskCheck, ReviewDetail } from '@/lib/practice-entities/desk';
import { NOTE_MAX, QUERY_SOURCE_MAX } from '@/lib/practice-entities/rules';

// 業別核對與統編認領的核對畫面（MIL-109、MIL-180）。業別核對：查商工登記與 resim 後，登錄營業項目、登記狀態與結果（ADR-0017 決議 10）。
// 統編認領：同時列出登錄者與認領方，由營運者判定歸屬。證據檔在這裡開啟，每次開啟都寫稽核事件。
// 系統不接任何外部查詢：商工登記與 resim 都是營運者人工查、人工登錄。
// 資料由 server component 載入（src/app/desk/items/[id]/page.tsx）。證書、任職、同意書與撞號項目有各自的畫面。

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

interface ClaimFormValues {
  decision: 'keep_registrant' | 'to_claimant';
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

function ChecksCard({ checks, kindOf }: { checks: DeskCheck[]; kindOf: (licenseId: string) => string }) {
  return (
    <Card size="small" title="歷次核對">
      <ListTable<DeskCheck>
        table={{
          rowKey: 'id',
          dataSource: checks,
          scroll: { x: 'max-content' },
          columns: [
            { title: '時間', dataIndex: 'checkedAt', width: 160, render: formatTaipeiDateTime },
            { title: '業別', dataIndex: 'licenseId', render: (id: string) => kindOf(id) },
            { title: '管道', dataIndex: 'channel', render: (c: string) => CHANNEL_LABEL[c] ?? c },
            { title: '查詢頁別', dataIndex: 'querySource' },
            { title: '結果', dataIndex: 'result', width: 100, render: (r: string) => resolutionLabel(r) },
            { title: '判定理由', dataIndex: 'note', render: (n: string) => n || '—' },
          ],
        }}
        emptyNode={null}
      />
    </Card>
  );
}

function Inner({ detail, nowIso }: { detail: ReviewDetail; nowIso: string }) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [shortfalls, setShortfalls] = useState<Shortfall[] | null>(null);
  const [checkForm] = Form.useForm<CheckFormValues>();
  const [claimForm] = Form.useForm<ClaimFormValues>();
  const result = Form.useWatch('result', checkForm);

  const { item, entity, license, claim } = detail;
  const itemId = item.id;
  const open = item.status === 'open';
  const step = deskNextStep(item);

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
        message.error(`${response.body.error ?? '操作失敗'}。請稍後再試。`);
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
          {entity && (
            <Card size="small" title="執業主體">
              <Descriptions
                size="small"
                column={1}
                items={[
                  { key: 'name', label: '名稱', children: entity.name },
                  { key: 'taxId', label: '統一編號', children: entity.taxId },
                  { key: 'type', label: '組織型態', children: ENTITY_TYPE_LABEL[entity.entityType] },
                  { key: 'org', label: '登錄者組織', children: entity.orgName },
                  { key: 'items', label: '營業項目', children: entity.businessItemCodes.length > 0 ? entity.businessItemCodes.join('、') : '尚未登錄' },
                  {
                    key: 'reg',
                    label: '登記狀態',
                    children: entity.registrationStatus ? `${entity.registrationStatus}（${formatTaipeiDateTime(entity.registrationCheckedAt)}）` : '尚未登錄',
                  },
                ]}
              />
            </Card>
          )}
        </>
      }
    >
      {license && (
        <Card size="small" title="業別">
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2 }}
            items={[
              { key: 'kind', label: '業別', children: statutoryTitle(license.kind) },
              { key: 'permit', label: '許可或登記證字號', children: license.permitNo ?? '—' },
              { key: 'state', label: '驗證狀態', children: stateLabel(license.state) },
              { key: 'submitted', label: '送件時間', children: formatTaipeiDateTime(license.submittedAt) },
            ]}
          />
        </Card>
      )}

      {claim && (
        <Card size="small" title="認領方">
          <Flex vertical gap="middle">
            <Alert
              type="info"
              showIcon
              title="另一個組織認領了同一個統一編號"
              description="請對照兩邊送的證明文件，判定這個統編歸屬哪個組織。判定結果只通知認領方，不通知原登錄者。"
            />
            <Descriptions
              size="small"
              column={{ xs: 1, sm: 2 }}
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
        </Card>
      )}

      <EvidenceCard title="證據檔" evidence={detail.evidence} emptyText="沒有證據檔。" />

      {detail.checks.length > 0 && (
        <ChecksCard
          checks={detail.checks}
          kindOf={(licenseId) => {
            const kind = entity?.licenses.find((l) => l.id === licenseId)?.kind;
            return kind ? statutoryTitle(kind) : '—';
          }}
        />
      )}

      {open && item.type === 'license' && license && (
        <Card size="small" title="登錄核對結果">
          <Form<CheckFormValues>
            form={checkForm}
            layout="vertical"
            requiredMark={false}
            disabled={busy}
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
            <Row gutter={16}>
              <Col xs={24} md={10}>
                <Form.Item label="核對管道" name="channel" rules={[{ required: true }]}>
                  <Select options={CHANNEL_OPTIONS} />
                </Form.Item>
              </Col>
              <Col xs={24} md={14}>
                <Form.Item
                  label="查詢的頁別"
                  name="querySource"
                  rules={[
                    { required: true, whitespace: true, message: '請填查詢的頁別，例如「商工登記公示資料查詢」' },
                    { max: QUERY_SOURCE_MAX, message: `不得超過 ${QUERY_SOURCE_MAX} 字` },
                  ]}
                >
                  <Input autoComplete="off" />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col xs={24} md={14}>
                <Form.Item
                  label="營業項目代碼"
                  name="businessItemCodes"
                  extra="商工登記上的全部營業項目。代管需要 H706011，包租需要 H706021，經紀需要 H704031。"
                >
                  <Select mode="tags" tokenSeparators={[',', '，', ' ']} placeholder="輸入代碼後按 Enter" open={false} />
                </Form.Item>
              </Col>
              <Col xs={24} md={10}>
                <Form.Item label="登記狀態" name="registrationStatus" extra="不是「核准設立」時，全部業別轉為已失效。">
                  <Input autoComplete="off" />
                </Form.Item>
              </Col>
            </Row>
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
              <Form.Item>
                <Alert
                  type="error"
                  showIcon
                  title="不符合業別規則，不能判定相符"
                  description={
                    <ul className={styles.reasonList}>
                      {shortfalls.map((reason) => (
                        <li key={`${reason.code}-${reason.kind}`}>{reason.message}</li>
                      ))}
                    </ul>
                  }
                />
              </Form.Item>
            )}
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={busy}>
                登錄核對結果
              </Button>
            </Form.Item>
          </Form>
        </Card>
      )}

      {open && item.type === 'entity_claim' && claim && (
        <Card size="small" title="判定歸屬">
          <Form<ClaimFormValues>
            form={claimForm}
            layout="vertical"
            requiredMark={false}
            disabled={busy}
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
        </Card>
      )}
    </DetailPage>
  );
}

// 沿用成員管理頁的做法：頁面自己包 AntApp，message 才吃得到主題
export default function DeskItemPanel({ detail, nowIso }: { detail: ReviewDetail; nowIso: string }) {
  return (
    <AntApp>
      <Inner detail={detail} nowIso={nowIso} />
    </AntApp>
  );
}
