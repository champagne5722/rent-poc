'use client';

import { Checkbox, DatePicker, Flex, Form, Input, Typography, Upload, Button } from 'antd';
import type { FormInstance, UploadFile } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
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
import shared from './shared.module.css';

// 謄本欄位群（MIL-206 畫面段）：業者代傳謄本用。欄位與規則和物件頁的謄本上傳表單（OwnershipPanel）相同：
// 檔案、主張的所有權人、謄本取得時間、信託登記四項。放在呼叫端的 Form 裡，欄位路徑是 [...prefix, 欄位名]。
// 業者代傳謄本不代表屋主同意個資告知，所以這裡沒有個資告知區塊。

export interface TranscriptFormValues {
  file?: UploadFile[];
  claimedOwner?: string;
  acquiredAt?: Dayjs;
  hasTrust?: boolean;
  trustRegisteredOwner?: string;
  trustRelatedParties?: string;
  trustRegistrationStatus?: string;
  trustLeaseClause?: string;
}

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

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/** 檔案欄位的檢查：必填、副檔名、大小。伺服器端另依檔案內容判斷類型。 */
export function validateTranscriptFile(_: unknown, files: UploadFile[] | undefined): Promise<void> {
  const file = files?.[0];
  if (!file) return Promise.reject(new Error('請選擇謄本檔案'));
  if (!TRANSCRIPT_ACCEPT.split(',').includes(fileExtension(file.name))) return Promise.reject(new Error('謄本必須是 PDF、PNG 或 JPG。請換一個檔案'));
  if ((file.size ?? 0) > TRANSCRIPT_MAX_BYTES) return Promise.reject(new Error(`檔案不得超過 ${TRANSCRIPT_MAX_MB} MB。請換一個較小的檔案`));
  return Promise.resolve();
}

/** 把謄本表單的值轉成 POST /api/mandate-requests/[id]/transcript 的 multipart 本文。沒有檔案回 null。 */
export function transcriptFormData(values: TranscriptFormValues): FormData | null {
  const file = values.file?.[0]?.originFileObj;
  if (!file || !values.acquiredAt) return null;
  const body = new FormData();
  body.set('file', file);
  body.set('claimed_owner', values.claimedOwner ?? '');
  body.set('acquired_at', values.acquiredAt.format('YYYY-MM-DD'));
  body.set('has_trust', values.hasTrust ? 'true' : 'false');
  if (values.hasTrust) {
    for (const field of TRUST_FIELDS) body.set(TRUST_FORM_KEYS[field], values[TRUST_FORM_NAMES[field]] ?? '');
  }
  return body;
}

export default function TranscriptFields({ form, prefix }: { form: FormInstance; prefix: string[] }) {
  const hasTrust = Form.useWatch([...prefix, 'hasTrust'], form);
  return (
    <>
      <Form.Item
        label="謄本檔案"
        name={[...prefix, 'file']}
        valuePropName="fileList"
        getValueFromEvent={(event: { fileList?: UploadFile[] }) => event?.fileList ?? []}
        rules={[{ validator: validateTranscriptFile }]}
        extra={`上傳第二類謄本。${TRANSCRIPT_FILE_RULE_TEXT}。`}
      >
        <Upload accept={TRANSCRIPT_ACCEPT} maxCount={1} beforeUpload={() => false}>
          <Button icon={<UploadOutlined />}>選擇檔案</Button>
        </Upload>
      </Form.Item>
      <Form.Item
        label="主張的所有權人"
        name={[...prefix, 'claimedOwner']}
        className={shared.fieldNarrow}
        rules={[
          { required: true, whitespace: true, message: '請填主張的所有權人' },
          { max: CLAIMED_OWNER_MAX, message: `所有權人不得超過 ${CLAIMED_OWNER_MAX} 字` },
        ]}
        extra="填物件的所有權人姓名。平台會與謄本上的登記名義人比對。"
      >
        <Input autoComplete="off" />
      </Form.Item>
      <Form.Item
        label="謄本取得時間"
        name={[...prefix, 'acquiredAt']}
        className={shared.fieldNarrow}
        rules={[{ required: true, message: '請填謄本的取得時間' }]}
      >
        <DatePicker format="YYYY-MM-DD" placeholder="選擇日期" disabledDate={(date) => date.isAfter(dayjs(), 'day')} allowClear={false} />
      </Form.Item>
      <Form.Item name={[...prefix, 'hasTrust']} valuePropName="checked">
        <Checkbox>謄本顯示信託登記</Checkbox>
      </Form.Item>
      {hasTrust && (
        <Flex vertical>
          <Typography.Paragraph type="secondary">謄本顯示信託登記時，必須補上下列四項資料。</Typography.Paragraph>
          {TRUST_FIELDS.map((field) => (
            <Form.Item
              key={field}
              label={TRUST_FIELD_LABELS[field]}
              name={[...prefix, TRUST_FORM_NAMES[field]]}
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
    </>
  );
}
