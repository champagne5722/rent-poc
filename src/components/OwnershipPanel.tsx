'use client';

import { useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Checkbox, DatePicker, Descriptions, Flex, Form, Input, Skeleton, Typography, Upload } from 'antd';
import type { UploadFile } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import EmptyState from '@/components/page/EmptyState';
import StatusTag from '@/components/StatusTag';
import { formatFileSize, formatTaipeiDate, formatTaipeiDateTime } from '@/lib/ownership/format';
import {
  CLAIMED_OWNER_MAX,
  TRANSCRIPT_ACCEPT,
  TRANSCRIPT_FILE_RULE_TEXT,
  TRANSCRIPT_MAX_BYTES,
  TRANSCRIPT_MAX_MB,
  TRUST_FIELD_LABELS,
  TRUST_FIELD_MAX,
  TRUST_FIELDS,
  type TrustField,
} from '@/lib/ownership/forms';
import { AWAITING_REVIEW_MESSAGE, NOT_SUBMITTED_MESSAGE } from '@/lib/ownership/messages';
import type { OwnershipSubmissionView, PropertyOwnership } from '@/lib/types';
import { trustDescriptionItems } from './ownership/trust';
import styles from './OwnershipPanel.module.css';
import shared from './ownership/shared.module.css';

// 物件頁的出租權源文件區塊（MIL-201，ADR-0026、ADR-0028 決議 3）。放在物件頁的「建號與核對」分頁。
// 顯示核對狀態、最新一次送件，以及個資告知與謄本上傳。
// 規則：
// - 個資告知必須先同意，上傳表單才能用。沒有同意時，表單整個停用。
// - 畫面的文字、狀態與按鈕，不讓登錄的一方分辨別的組織是否登錄過同一個建號。文字全部來自 API 回傳的固定訊息。
// - 謄本原檔只在審核台顯示。這裡只列檔名與大小，不提供開啟原檔的連結。
// - 物件頁已有一顆 primary 按鈕（新增分租單位），所以這個區塊的按鈕都用 default。

const TRUST_FORM_NAMES: Record<TrustField, 'trustRegisteredOwner' | 'trustRelatedParties' | 'trustRegistrationStatus' | 'trustLeaseClause'> = {
  registeredOwner: 'trustRegisteredOwner',
  relatedParties: 'trustRelatedParties',
  registrationStatus: 'trustRegistrationStatus',
  leaseClause: 'trustLeaseClause',
};

const TRUST_FORM_KEYS: Record<TrustField, 'trust_registered_owner' | 'trust_related_parties' | 'trust_registration_status' | 'trust_lease_clause'> = {
  registeredOwner: 'trust_registered_owner',
  relatedParties: 'trust_related_parties',
  registrationStatus: 'trust_registration_status',
  leaseClause: 'trust_lease_clause',
};

const TRUST_FIELD_ORDER = TRUST_FIELDS;

interface TranscriptFormValues {
  file: UploadFile[];
  claimedOwner: string;
  acquiredAt: Dayjs;
  hasTrust: boolean;
  trustRegisteredOwner?: string;
  trustRelatedParties?: string;
  trustRegistrationStatus?: string;
  trustLeaseClause?: string;
}

interface ApiError {
  error?: string;
  code?: string;
  field?: string;
  missing?: TrustField[];
}

const LOAD_ERROR = '讀不到文件核對狀態。請按「重新載入」，仍然失敗時請稍後再試。';

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/** 檔案欄位的檢查：必填、副檔名、大小。伺服器端另依檔案內容判斷類型。 */
function validateFile(_: unknown, files: UploadFile[] | undefined): Promise<void> {
  const file = files?.[0];
  if (!file) return Promise.reject(new Error('請選擇謄本檔案'));
  if (!TRANSCRIPT_ACCEPT.split(',').includes(fileExtension(file.name))) return Promise.reject(new Error('謄本必須是 PDF、PNG 或 JPG。請換一個檔案'));
  if ((file.size ?? 0) > TRANSCRIPT_MAX_BYTES) return Promise.reject(new Error(`檔案不得超過 ${TRANSCRIPT_MAX_MB} MB。請換一個較小的檔案`));
  return Promise.resolve();
}

function SubmissionSummary({ ownership, submission }: { ownership: PropertyOwnership; submission: OwnershipSubmissionView }) {
  const verified = ownership.node_status === 'verified';
  return (
    <Descriptions
      size="small"
      column={1}
      title={`最新一次送件（第 ${submission.seq} 次）`}
      items={[
        { key: 'owner', label: '你主張的所有權人', children: submission.claimed_owner_name },
        { key: 'acquired', label: '謄本取得時間', children: formatTaipeiDate(submission.acquired_at) },
        { key: 'file', label: '謄本檔案', children: `${submission.file_name}（${formatFileSize(submission.byte_size)}）` },
        { key: 'submitted', label: '送出時間', children: formatTaipeiDateTime(submission.submitted_at) },
        ...trustDescriptionItems(submission.trust),
        ...(verified || ownership.node_status === 'failed'
          ? [
              { key: 'checked', label: '核對時間', children: formatTaipeiDateTime(ownership.checked_at) },
              { key: 'holder', label: '謄本登記名義人（已遮罩）', children: ownership.holder_masked ?? '—' },
            ]
          : []),
      ]}
    />
  );
}

function StatusBlock({ ownership, archived }: { ownership: PropertyOwnership; archived: boolean }) {
  const { node_status: nodeStatus, messages, submission } = ownership;

  let top;
  if (nodeStatus === null || nodeStatus === 'lapsed') {
    top = (
      <EmptyState
        description={
          !ownership.has_key
            ? '這個物件還沒有建號。請先補建號，再上傳謄本。'
            : archived
              ? '物件已封存，不能上傳謄本。'
              : NOT_SUBMITTED_MESSAGE
        }
      />
    );
  } else if (nodeStatus === 'failed') {
    top = (
      <Alert
        type="error"
        showIcon
        title="文件核對未通過"
        description={
          <Flex vertical gap="small">
            <ul className={shared.messageList}>
              {messages.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            <span>請依訊息修正，再重新送出謄本。</span>
          </Flex>
        }
      />
    );
  } else if (nodeStatus === 'verified') {
    top = <Alert type="success" showIcon title="已核對" description={ownership.verified_note ?? messages[0]} />;
  } else {
    top = <Alert type="info" showIcon title={messages[0] ?? AWAITING_REVIEW_MESSAGE} description="平台核對完成後，會用站內通知告訴你結果。" />;
  }

  return (
    <Flex vertical gap="middle">
      {top}
      {submission && nodeStatus !== null && <SubmissionSummary ownership={ownership} submission={submission} />}
    </Flex>
  );
}

function ConsentBlock({ ownership, onChange }: { ownership: PropertyOwnership; onChange: (next: PropertyOwnership) => void }) {
  const { message } = AntApp.useApp();
  const [busy, setBusy] = useState<'agree' | 'object' | null>(null);
  const [objected, setObjected] = useState(false);

  const send = async (decision: 'agree' | 'object') => {
    setBusy(decision);
    try {
      const res = await fetch(`/api/properties/${encodeURIComponent(ownership.property_id)}/ownership/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const json = (await res.json().catch(() => ({}))) as { data?: PropertyOwnership } & ApiError;
      if (!res.ok || !json.data) {
        message.error(`${json.error ?? '記錄失敗'}。請稍後再按一次。`);
        return;
      }
      setObjected(decision === 'object');
      onChange(json.data);
    } catch {
      message.error('網路發生問題。請檢查連線後再按一次。');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Flex vertical gap="middle">
      <Flex vertical gap="small">
        <h3 className="type-section-title">{ownership.consent.title}</h3>
        <Typography.Paragraph className={styles.noticeText}>{ownership.consent.text}</Typography.Paragraph>
      </Flex>
      {objected && <Alert type="info" showIcon title="你選了不同意，所以不能上傳謄本。想上傳時，請再按「同意並繼續」。" />}
      <Flex gap="small" wrap>
        <Button loading={busy === 'agree'} disabled={busy !== null} onClick={() => void send('agree')}>
          同意並繼續
        </Button>
        <Button loading={busy === 'object'} disabled={busy !== null} onClick={() => void send('object')}>
          不同意
        </Button>
      </Flex>
    </Flex>
  );
}

function TranscriptForm({ ownership, onSubmitted }: { ownership: PropertyOwnership; onSubmitted: () => void }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<TranscriptFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const hasTrust = Form.useWatch('hasTrust', form);
  const agreed = ownership.consent.agreed;
  const resubmitting = ownership.node_status === 'failed';

  const submit = async (values: TranscriptFormValues) => {
    const file = values.file[0]?.originFileObj;
    if (!file) {
      form.setFields([{ name: 'file', errors: ['請選擇謄本檔案'] }]);
      return;
    }
    const body = new FormData();
    body.set('file', file);
    body.set('claimed_owner', values.claimedOwner);
    body.set('acquired_at', values.acquiredAt.format('YYYY-MM-DD'));
    body.set('has_trust', values.hasTrust ? 'true' : 'false');
    if (values.hasTrust) {
      for (const field of TRUST_FIELD_ORDER) body.set(TRUST_FORM_KEYS[field], values[TRUST_FORM_NAMES[field]] ?? '');
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/properties/${encodeURIComponent(ownership.property_id)}/ownership`, { method: 'POST', body });
      const json = (await res.json().catch(() => ({}))) as { data?: { message?: string } } & ApiError;
      if (res.ok) {
        message.success(json.data?.message ?? AWAITING_REVIEW_MESSAGE);
        form.resetFields();
        onSubmitted();
        return;
      }
      if (json.code === 'trust_incomplete' && json.missing) {
        form.setFields(json.missing.map((f) => ({ name: TRUST_FORM_NAMES[f], errors: [`請填${TRUST_FIELD_LABELS[f]}`] })));
        return;
      }
      if (json.field === 'claimedOwner' || json.field === 'acquiredAt' || json.field === 'file') {
        form.setFields([{ name: json.field, errors: [json.error ?? '欄位有誤，請修正後再送出'] }]);
        return;
      }
      if (res.status === 409 || json.code === 'consent_required') {
        // 狀態已經變了（例如別的視窗已送出）：更新畫面，讓使用者看到最新狀態
        message.error(`${json.error ?? '目前不能送出謄本'}。畫面已更新為最新狀態。`);
        onSubmitted();
        return;
      }
      message.error(`${json.error ?? '送出失敗'}。請檢查欄位後再送出一次。`);
    } catch {
      message.error('網路發生問題。請檢查連線後再送出一次。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Flex vertical gap="middle">
      {agreed ? (
        <Typography.Text type="secondary" className="type-caption">
          你已同意「{ownership.consent.title}」。
        </Typography.Text>
      ) : (
        <Typography.Text type="secondary" className="type-caption">
          同意個資告知後，才能上傳謄本。
        </Typography.Text>
      )}
      <Form<TranscriptFormValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        disabled={!agreed || submitting}
        initialValues={{ claimedOwner: resubmitting ? ownership.submission?.claimed_owner_name : undefined, hasTrust: false, file: [] }}
        onFinish={(values) => void submit(values)}
      >
        <Form.Item
          label="謄本檔案"
          name="file"
          valuePropName="fileList"
          getValueFromEvent={(event: { fileList?: UploadFile[] }) => event?.fileList ?? []}
          rules={[{ validator: validateFile }]}
          extra={`上傳第二類謄本。${TRANSCRIPT_FILE_RULE_TEXT}。`}
        >
          <Upload accept={TRANSCRIPT_ACCEPT} maxCount={1} beforeUpload={() => false}>
            <Button icon={<UploadOutlined />}>選擇檔案</Button>
          </Upload>
        </Form.Item>
        <Form.Item
          label="你主張的所有權人"
          name="claimedOwner"
          className={shared.fieldNarrow}
          rules={[
            { required: true, whitespace: true, message: '請填你主張的所有權人' },
            { max: CLAIMED_OWNER_MAX, message: `所有權人不得超過 ${CLAIMED_OWNER_MAX} 字` },
          ]}
          extra="填物件的所有權人姓名。平台會與謄本上的登記名義人比對。"
        >
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item
          label="謄本取得時間"
          name="acquiredAt"
          className={shared.fieldNarrow}
          rules={[{ required: true, message: '請填謄本的取得時間' }]}
        >
          <DatePicker format="YYYY-MM-DD" placeholder="選擇日期" disabledDate={(date) => date.isAfter(dayjs(), 'day')} allowClear={false} />
        </Form.Item>
        <Form.Item name="hasTrust" valuePropName="checked">
          <Checkbox>謄本顯示信託登記</Checkbox>
        </Form.Item>
        {hasTrust && (
          <Flex vertical>
            <Typography.Paragraph type="secondary">謄本顯示信託登記時，必須補上下列四項資料。</Typography.Paragraph>
            {TRUST_FIELD_ORDER.map((field) => (
              <Form.Item
                key={field}
                label={TRUST_FIELD_LABELS[field]}
                name={TRUST_FORM_NAMES[field]}
                className={shared.fieldMedium}
                rules={[
                  { required: true, whitespace: true, message: `請填${TRUST_FIELD_LABELS[field]}` },
                  { max: TRUST_FIELD_MAX, message: `${TRUST_FIELD_LABELS[field]}不得超過 ${TRUST_FIELD_MAX} 字` },
                ]}
              >
                {field === 'leaseClause' ? <Input.TextArea rows={3} maxLength={TRUST_FIELD_MAX} showCount /> : <Input autoComplete="off" />}
              </Form.Item>
            ))}
          </Flex>
        )}
        <Form.Item>
          <Button htmlType="submit" loading={submitting}>
            {resubmitting ? '重新送出謄本' : '送出謄本'}
          </Button>
        </Form.Item>
      </Form>
    </Flex>
  );
}

export interface OwnershipPanelProps {
  propertyId: string;
  /** 物件已封存：不能上傳謄本。 */
  archived: boolean;
  /** 父頁重新載入物件時加一，這裡跟著重讀。 */
  reloadToken: number;
  /** 送件成功或狀態改變後呼叫，父頁重讀物件（核對狀態在別的分頁也會用到）。 */
  onChanged: () => void;
}

export default function OwnershipPanel({ propertyId, archived, reloadToken, onChanged }: OwnershipPanelProps) {
  const [ownership, setOwnership] = useState<PropertyOwnership | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // 分頁被切到時才掛載，所以這不是頁面的首屏資料。已有資料時重讀不清空畫面，避免版面跳動
  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        const res = await fetch(`/api/properties/${encodeURIComponent(propertyId)}/ownership`);
        const json = res.ok ? ((await res.json()) as { data?: PropertyOwnership }) : null;
        if (stale) return;
        if (json?.data) {
          setOwnership(json.data);
          setFailed(false);
        } else {
          setFailed(true);
        }
      } catch {
        if (!stale) setFailed(true);
      }
    })();
    return () => {
      stale = true;
    };
  }, [propertyId, reloadToken, attempt]);

  if (ownership === null) {
    if (failed) {
      return (
        <Alert
          type="error"
          showIcon
          title={LOAD_ERROR}
          action={
            <Button
              onClick={() => {
                setFailed(false);
                setAttempt((n) => n + 1);
              }}
            >
              重新載入
            </Button>
          }
        />
      );
    }
    return (
      <Card size="small" title="出租權源文件" aria-label="出租權源文件載入中">
        <Skeleton active paragraph={{ rows: 4 }} />
      </Card>
    );
  }

  const showForm = ownership.can_submit && !archived;

  return (
    <Flex vertical gap="middle">
      {failed && <Alert type="warning" showIcon title="重新讀取失敗，下方是上一次讀到的狀態。請稍後重新整理頁面。" />}
      <Card size="small" title="出租權源文件" extra={<StatusTag kind="propertyVerification" value={ownership.verification_status} />}>
        <StatusBlock ownership={ownership} archived={archived} />
      </Card>
      {showForm && !ownership.consent.agreed && (
        <Card size="small" title="個資告知">
          <ConsentBlock ownership={ownership} onChange={setOwnership} />
        </Card>
      )}
      {showForm && (
        <Card size="small" title={ownership.node_status === 'failed' ? '修正後重新送出' : '上傳謄本'}>
          <TranscriptForm ownership={ownership} onSubmitted={onChanged} />
        </Card>
      )}
    </Flex>
  );
}
