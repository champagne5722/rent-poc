'use client';

import { useState } from 'react';
import { Alert, App as AntApp, Button, Card, Descriptions, Flex, Form, Input, Popconfirm, Radio, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import EmptyState from '@/components/page/EmptyState';
import DetailPage from '@/components/page/DetailPage';
import NextStep from '@/components/page/NextStep';
import StatusTag from '@/components/StatusTag';
import { shortUlid } from '@/lib/pg/ulid';
import { formatFileSize, formatTaipeiDate, formatTaipeiDateTime } from '@/lib/ownership/format';
import { HOLDER_MASKED_MAX, REASON_MAX, validateCheckForm, type CheckFormField } from '@/lib/ownership/forms';
import { HELD_MESSAGE, mismatchMessages } from '@/lib/ownership/messages';
import { documentCheckResult, ownershipItemStatus } from '@/lib/ownership/review-status';
import { formatWaiting, queueTypeLabel } from '@/lib/practice-entities/display';
import { statusPresentation } from '@/lib/status-presentation';
import type { OwnershipReviewDetail } from '@/lib/ownership/desk';
import { trustDescriptionItems } from './ownership/trust';
import shared from './ownership/shared.module.css';
import styles from './OwnershipReviewPanel.module.css';

// 審核台的出租權源核對面板（MIL-201，ADR-0026 決議 7，ADR-0028 決議 3）。
// 並排顯示登錄方填的建號與使用者送的謄本資料，營運者分別判定「建號是否與謄本相符」與「登記名義人是否與主張的所有權人相符」。
// 謄本原檔在這裡開啟，每次開啟都寫稽核事件。判定送出後不能更改，理由必填（與 API 的驗證一致，畫面不放寬）。
// 項目停在待處理（held）時，只有營運者看得到說明，也不再顯示判定表單。

interface DecisionFormValues {
  keyMatch: boolean;
  holderMatch: boolean;
  holderMasked: string;
  reason: string;
}

interface ApiError {
  error?: string;
  field?: string;
}

const DECISION_FIELDS: readonly CheckFormField[] = ['keyMatch', 'holderMatch', 'holderMasked', 'reason'];

/** 登記名義人欄位的檢查，與 API 同一個函式（不含證號）。 */
function validateHolderMasked(_: unknown, value: string | undefined): Promise<void> {
  const result = validateCheckForm({ keyMatch: true, holderMatch: true, holderMasked: value, reason: '—' });
  return result.ok || result.field !== 'holderMasked' ? Promise.resolve() : Promise.reject(new Error(result.message));
}

function nextStepFor(detail: OwnershipReviewDetail, hasSubmission: boolean) {
  const { item } = detail;
  const status = ownershipItemStatus(item);
  const tone = statusPresentation('ownershipItem', status).tone;
  const waiting = `等待時間：${formatWaiting(item.waitingBusinessMs)}（只算週一到週五）。目標是 1 個工作日內完成核對。`;
  if (!hasSubmission) {
    return { tone, headline: '審核修正建號', owner: '平台營運者', detail: '這個項目沒有謄本，審核動作尚未提供。' };
  }
  switch (status) {
    case 'pending':
    case 'overdue':
      return { tone, headline: '核對謄本與登錄資料', owner: '平台營運者', detail: waiting };
    case 'held':
      return { tone, headline: '個別聯絡雙方後處理', owner: '平台營運者', detail: HELD_MESSAGE };
    case 'verified':
      return { tone, headline: '已通過核對', owner: '平台營運者', detail: '物件對外狀態是「已核對」，登錄的一方已收到站內通知。' };
    case 'failed':
      return { tone, headline: '核對未通過，等待登錄的一方補件', owner: '登錄的一方', detail: '登錄的一方已收到站內通知，補件後會有新的項目。' };
    case 'superseded':
      return { tone, headline: '項目已被新的項目取代', owner: '平台營運者', detail: '不需要處理。' };
  }
}

function ComparePanels({ detail }: { detail: OwnershipReviewDetail }) {
  const { claimedKey: key, claimedKeyNames: names, submission } = detail;
  const section = [names.sectionName, names.sectionSubName].filter(Boolean).join(' ');
  return (
    <div className={styles.compare}>
      <Card size="small" title="登錄方填的資料">
        <Descriptions
          size="small"
          column={1}
          items={[
            { key: 'org', label: '登錄方組織', children: detail.claimantOrgName ?? '—' },
            { key: 'city', label: '縣市', children: names.cityName ?? key.cityCode },
            { key: 'town', label: '鄉鎮市區', children: names.townName ?? key.townCode },
            { key: 'section', label: '段小段', children: section || key.sectionCode },
            { key: 'building', label: '建號', children: `${key.buildingNo}-${key.subNo}` },
          ]}
        />
      </Card>
      <Card size="small" title="使用者送的謄本資料">
        {submission ? (
          <Flex vertical gap="small">
            <Descriptions
              size="small"
              column={1}
              items={[
                { key: 'owner', label: '主張的所有權人', children: submission.claimed_owner_name },
                { key: 'acquired', label: '謄本取得時間', children: formatTaipeiDate(submission.acquired_at) },
                { key: 'submitted', label: '送出時間', children: formatTaipeiDateTime(submission.submitted_at) },
                { key: 'seq', label: '送件次數', children: `第 ${submission.seq} 次` },
                {
                  key: 'file',
                  label: '謄本原檔',
                  children: detail.fileUrl ? (
                    <a href={detail.fileUrl} target="_blank" rel="noreferrer">
                      開啟 {submission.file_name}（{formatFileSize(submission.byte_size)}）
                    </a>
                  ) : (
                    submission.file_name
                  ),
                },
                ...trustDescriptionItems(submission.trust),
              ]}
            />
            <Typography.Text type="secondary" className="type-caption">
              每次開啟原檔都會留下稽核紀錄。
            </Typography.Text>
          </Flex>
        ) : (
          <EmptyState description="這個項目沒有謄本送件。" />
        )}
      </Card>
    </div>
  );
}

function DecisionForm({ itemId }: { itemId: string }) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [form] = Form.useForm<DecisionFormValues>();
  const [busy, setBusy] = useState(false);
  const keyMatch = Form.useWatch('keyMatch', form);
  const holderMatch = Form.useWatch('holderMatch', form);

  const decided = keyMatch !== undefined && holderMatch !== undefined;
  const willVerify = keyMatch === true && holderMatch === true;
  const userMessages = decided ? mismatchMessages({ keyMatch: keyMatch === true, holderMatch: holderMatch === true }) : [];

  const submit = async (values: DecisionFormValues) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/desk/ownership/${encodeURIComponent(itemId)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key_match: values.keyMatch,
          holder_match: values.holderMatch,
          holder_masked: values.holderMasked,
          reason: values.reason,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { data?: { outcome?: string; message?: string } } & ApiError;
      if (res.ok) {
        if (json.data?.outcome === 'held') {
          message.info(json.data.message ?? HELD_MESSAGE);
          router.refresh();
          return;
        }
        message.success(json.data?.outcome === 'verified' ? '已判定通過。登錄的一方會收到站內通知。' : '已判定不符。登錄的一方會收到站內通知。');
        router.push('/desk');
        return;
      }
      const field = DECISION_FIELDS.find((f) => f === json.field);
      if (res.status === 400 && field) {
        form.setFields([{ name: field, errors: [json.error ?? '欄位有誤，請修正後再送出'] }]);
        return;
      }
      if (res.status === 409) {
        message.error(`${json.error ?? '這個項目已經判定過'}。畫面已更新為最新狀態。`);
        router.refresh();
        return;
      }
      if (res.status === 401 || res.status === 403) {
        message.error('只有平台營運者身分能判定。請從右上角切換身分後再試。');
        return;
      }
      if (res.status === 404) {
        message.error('找不到這個審核項目。請回審核台確認項目還在。');
        return;
      }
      message.error(`${json.error ?? '判定失敗'}。請稍後再送出一次。`);
    } catch {
      message.error('網路發生問題。請檢查連線後再送出一次。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card size="small" title="判定">
      <Form<DecisionFormValues> form={form} layout="vertical" requiredMark={false} disabled={busy} onFinish={(values) => void submit(values)}>
        <Form.Item label="建號是否與謄本相符" name="keyMatch" rules={[{ required: true, message: '請判定建號是否與謄本相符' }]}>
          <Radio.Group
            options={[
              { value: true, label: '建號相符' },
              { value: false, label: '建號不符' },
            ]}
          />
        </Form.Item>
        <Form.Item
          label="登記名義人是否與主張的所有權人相符"
          name="holderMatch"
          rules={[{ required: true, message: '請判定登記名義人是否與主張的所有權人相符' }]}
        >
          <Radio.Group
            options={[
              { value: true, label: '名義人相符' },
              { value: false, label: '名義人不符' },
            ]}
          />
        </Form.Item>
        <Form.Item
          label="謄本上的登記名義人（已遮罩）"
          name="holderMasked"
          className={shared.fieldNarrow}
          extra="照謄本原樣填遮罩後的姓名。不得填身分證字號。"
          rules={[
            { required: true, whitespace: true, message: '請照謄本填登記名義人（已遮罩）' },
            { max: HOLDER_MASKED_MAX, message: `登記名義人不得超過 ${HOLDER_MASKED_MAX} 字` },
            { validator: validateHolderMasked },
          ]}
        >
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item
          label="判定理由"
          name="reason"
          className={shared.fieldMedium}
          extra="理由記在判定紀錄。登錄的一方不會看到這段理由，只會看到固定訊息。"
          rules={[
            { required: true, whitespace: true, message: '請填判定理由' },
            { max: REASON_MAX, message: `判定理由不得超過 ${REASON_MAX} 字` },
          ]}
        >
          <Input.TextArea rows={3} maxLength={REASON_MAX} showCount />
        </Form.Item>
        {decided && (
          <Flex vertical gap="small">
            <Flex align="center" gap="small">
              <Typography.Text>送出後，物件對外狀態是</Typography.Text>
              <StatusTag kind="propertyVerification" value={willVerify ? 'verified' : 'failed'} />
            </Flex>
            {userMessages.length > 0 && (
              <Alert
                type="info"
                showIcon
                title="登錄的一方會看到下列固定訊息"
                description={
                  <ul className={shared.messageList}>
                    {userMessages.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                }
              />
            )}
          </Flex>
        )}
        <Form.Item>
          <Popconfirm title="確定送出判定？" description="判定送出後不能更改。" okText="送出" cancelText="取消" onConfirm={() => form.submit()}>
            <Button type="primary" loading={busy}>
              送出判定
            </Button>
          </Popconfirm>
        </Form.Item>
      </Form>
    </Card>
  );
}

function ResultPanel({ detail }: { detail: OwnershipReviewDetail }) {
  const { node, item } = detail;
  return (
    <Card size="small" title="判定結果">
      <Descriptions
        size="small"
        column={1}
        items={[
          { key: 'result', label: '結果', children: <StatusTag kind="ownershipItem" value={ownershipItemStatus(item)} /> },
          { key: 'key', label: '建號是否與謄本相符', children: <StatusTag kind="documentCheck" value={documentCheckResult(node?.key_match ?? null)} /> },
          { key: 'holder', label: '登記名義人是否相符', children: <StatusTag kind="documentCheck" value={documentCheckResult(node?.holder_match ?? null)} /> },
          { key: 'masked', label: '謄本上的登記名義人（已遮罩）', children: node?.holder_masked ?? '—' },
          { key: 'checked', label: '判定時間', children: formatTaipeiDateTime(node?.checked_at ?? item.resolvedAt) },
        ]}
      />
    </Card>
  );
}

function Inner({ detail }: { detail: OwnershipReviewDetail }) {
  const { item, submission } = detail;
  const status = ownershipItemStatus(item);
  const open = item.status === 'open';
  const step = nextStepFor(detail, submission !== null);

  return (
    <DetailPage
      header={{
        title: '出租權源核對',
        tag: <StatusTag kind="ownershipItem" value={status} />,
        back: { href: '/desk', label: '返回審核台' },
      }}
      notices={
        item.held ? (
          <Alert type="warning" showIcon title="兩項都相符，但這個項目停在待處理" description={`${HELD_MESSAGE}。這段說明只有平台營運者看得到。`} />
        ) : undefined
      }
      nextStep={<NextStep headline={step.headline} owner={step.owner} detail={step.detail} tone={step.tone} />}
      aside={
        <Card size="small" title="項目屬性">
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 'type', label: '類型', children: queueTypeLabel(item.type) },
              { key: 'id', label: '項目編號末碼', children: shortUlid(item.id) },
              { key: 'org', label: '登錄方組織', children: detail.claimantOrgName ?? '—' },
              { key: 'created', label: '排進審核台', children: formatTaipeiDateTime(item.createdAt) },
              { key: 'waiting', label: open ? '等待時間' : '等待了', children: formatWaiting(item.waitingBusinessMs) },
              ...(item.resolvedAt ? [{ key: 'resolved', label: '結案時間', children: formatTaipeiDateTime(item.resolvedAt) }] : []),
            ]}
          />
        </Card>
      }
    >
      {submission === null ? (
        <Card size="small" title="比對資料">
          <EmptyState description="這個項目沒有謄本送件。修正建號項目的審核動作尚未提供。" />
        </Card>
      ) : (
        <>
          <ComparePanels detail={detail} />
          {open && !item.held && <DecisionForm itemId={item.id} />}
          {!open && <ResultPanel detail={detail} />}
        </>
      )}
    </DetailPage>
  );
}

// 沿用其他審核台面板的做法：自己包 AntApp，message 才吃得到主題
export default function OwnershipReviewPanel({ detail }: { detail: OwnershipReviewDetail }) {
  return (
    <AntApp>
      <Inner detail={detail} />
    </AntApp>
  );
}
