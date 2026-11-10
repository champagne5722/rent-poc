'use client';

import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Alert, Button, Col, DatePicker, Descriptions, Flex, Form, InputNumber, Modal, Radio, Row, Select, Table, Tag, Typography, Upload, theme } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import type { DepositLedger } from '@/lib/case-ledger';
import { formatTaipei } from '@/lib/case-display';
import {
  DEPOSIT_HOLDER_MESSAGE_TEXT,
  DEPOSIT_LEDGER_STATUS_LABELS,
  RECEIPT_HOLDER_CONFIRM_NOTE,
  RECEIPT_PURPOSE_LABELS,
  receiptSourceLabel,
} from '@/lib/labels/case-ledger-labels';
import type { PeriodView, ReceiptListItem } from '@/lib/ledger/receipts';
import { HOLDER_KIND_LABELS } from '@/lib/payment-accounts/input';
import StatusTag from './StatusTag';

// 案件的入帳畫面（MIL-125）：押金台帳、應收期別、登錄入帳確認、入帳紀錄。
// 資料由 GET /api/cases/[id]/ledger 提供，登錄走 POST /api/cases/[id]/receipts。
// 編輯控制項由 API 回傳的 canRecordPayment 決定，真正的檢查在 route（authorize()）。
// 介面不顯示借貸，不出現「信託」字樣。狀態的名稱與顏色用 StatusTag（MIL-172）。

export interface ReceiptsSetup {
  canRecordPayment: boolean;
  depositLedger: DepositLedger | null;
  depositBalance: number;
  depositCollected: number;
  prepaidBalance: number;
  periods: PeriodView[];
  receipts: ReceiptListItem[];
  defaultAccounts: { rentAccountId: string | null; depositAccountId: string | null } | null;
}

interface AccountOption {
  id: string;
  name: string;
  holderKind: keyof typeof HOLDER_KIND_LABELS;
  isCash: boolean;
  active: boolean;
}

interface HolderNotice {
  action: 'warn' | 'warn_fix_mandate' | 'block';
  text: string;
}

const money = (n: number) => `$${n.toLocaleString('zh-TW')}`;
const newKey = () => `form-${crypto.randomUUID()}`;

function SectionTitle({ children }: { children: string }) {
  return <Typography.Text strong>{children}</Typography.Text>;
}

// --- 押金台帳 ---

export function DepositSection({ setup }: { setup: ReceiptsSetup }) {
  const ledger = setup.depositLedger;
  return (
    <Flex vertical gap="small">
      <SectionTitle>押金台帳</SectionTitle>
      {ledger === null ? (
        <Typography.Text type="secondary">合約全員簽署完成後，系統自動建立押金台帳與應收期別。</Typography.Text>
      ) : (
        <Descriptions
          column={1}
          size="small"
          bordered
          items={[
            { key: 'expected', label: '約定金額', children: money(ledger.expectedAmount) },
            { key: 'collected', label: '累計已收', children: money(setup.depositCollected) },
            {
              key: 'gap',
              label: '尚未收足',
              children:
                setup.depositCollected >= ledger.expectedAmount ? (
                  '已收足'
                ) : (
                  <Typography.Text type="warning">{money(ledger.expectedAmount - setup.depositCollected)}</Typography.Text>
                ),
            },
            { key: 'balance', label: '目前餘額', children: money(setup.depositBalance) },
            { key: 'status', label: '狀態', children: DEPOSIT_LEDGER_STATUS_LABELS[ledger.status] },
          ]}
        />
      )}
    </Flex>
  );
}

// --- 應收期別 ---

export function PeriodsSection({ setup }: { setup: ReceiptsSetup }) {
  return (
    <Flex vertical gap="small">
      <SectionTitle>應收期別</SectionTitle>
      {setup.prepaidBalance > 0 && (
        <Typography.Text>
          預收租金：<Typography.Text strong>{money(setup.prepaidBalance)}</Typography.Text>
          <Typography.Text type="secondary">（超過應收期別的入帳，使用者選擇抵充前留在案件中）</Typography.Text>
        </Typography.Text>
      )}
      <Table<PeriodView>
        rowKey="id"
        size="small"
        dataSource={setup.periods}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{
          emptyText: setup.depositLedger ? '合約欄位不足（缺少月租、付款日或有效的租期），系統沒有產生應收期別。' : '合約全員簽署完成後才會產生',
        }}
        columns={[
          { title: '期別', dataIndex: 'periodKey', width: 100 },
          { title: '涵蓋日期', width: 220, render: (_, p) => `${p.periodStart} 至 ${p.periodEnd}` },
          { title: '到期日', dataIndex: 'dueDate', width: 120 },
          { title: '應收金額', width: 110, align: 'right', render: (_, p) => money(p.amount) },
          { title: '已入帳', width: 110, align: 'right', render: (_, p) => money(p.allocated) },
          {
            title: '差額',
            width: 110,
            align: 'right',
            render: (_, p) => (p.outstanding > 0 ? <Typography.Text type={p.overdue ? 'danger' : undefined}>{money(p.outstanding)}</Typography.Text> : '—'),
          },
          {
            title: '狀態',
            width: 110,
            render: (_, p) => <StatusTag kind="receivablePeriod" value={p.overdue ? 'overdue' : p.status} />,
          },
        ]}
      />
    </Flex>
  );
}

// --- 登錄入帳確認 ---

interface FormValues {
  purpose: 'rent' | 'security_deposit';
  amount: number | null;
  valueDate: Dayjs;
  paymentAccountId?: string;
  evidence?: { originFileObj?: File }[];
}

export function RecordReceiptSection({ caseId, setup, onChanged }: { caseId: string; setup: ReceiptsSetup; onChanged: (text: string) => Promise<void> }) {
  const { message, modal } = AntApp.useApp();
  const { token } = theme.useToken();
  const [form] = Form.useForm<FormValues>();
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<HolderNotice | null>(null);
  // 表單產生的冪等鍵：連點兩次只入帳一次。成功後換新的，失敗時沿用，重試不會重複入帳
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const purpose = Form.useWatch('purpose', form) ?? 'rent';

  useEffect(() => {
    void fetch('/api/payment-accounts')
      .then((res) => (res.ok ? res.json() : { data: [] }))
      .then((json) => setAccounts(json.data as AccountOption[]));
  }, []);

  const options = useMemo(
    () => accounts.filter((a) => a.active).map((a) => ({ value: a.id, label: `${a.name}（${a.isCash ? '現金收取' : HOLDER_KIND_LABELS[a.holderKind]}）` })),
    [accounts],
  );
  const defaultFor = (p: FormValues['purpose']) => (p === 'rent' ? setup.defaultAccounts?.rentAccountId : setup.defaultAccounts?.depositAccountId) ?? undefined;

  // 用途改變時，用該用途的預設收款帳戶預填。使用者已選的帳戶不被蓋掉
  useEffect(() => {
    if (!form.getFieldValue('paymentAccountId')) form.setFieldValue('paymentAccountId', defaultFor(purpose));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在用途與預設帳戶改變時預填
  }, [purpose, setup.defaultAccounts, accounts]);

  const submit = async (values: FormValues, acknowledge: boolean) => {
    setBusy(true);
    setBlocked(null);
    try {
      const data = new FormData();
      data.set('idempotencyKey', idempotencyKey);
      data.set('purpose', values.purpose);
      data.set('amount', String(values.amount ?? ''));
      data.set('valueDate', values.valueDate.format('YYYY-MM-DD'));
      data.set('paymentAccountId', values.paymentAccountId ?? '');
      if (acknowledge) data.set('acknowledgeHolderWarning', 'true');
      const file = values.evidence?.[0]?.originFileObj;
      if (file) data.set('evidence', file);

      const res = await fetch(`/api/cases/${caseId}/receipts`, { method: 'POST', body: data });
      const json = await res.json();
      if (res.ok) {
        const result = json.data as { prepaid: number; allocations: { periodKey: string; amount: number }[]; evidenceReused: boolean };
        const parts = result.allocations.map((a) => `${a.periodKey} ${money(a.amount)}`);
        if (result.prepaid > 0) parts.push(`預收租金 ${money(result.prepaid)}`);
        form.setFieldsValue({ amount: null, evidence: [] });
        setIdempotencyKey(newKey());
        if (result.evidenceReused) message.warning('這份證明檔已用在另一筆入帳確認，請確認沒有重複登錄');
        await onChanged(parts.length > 0 ? `已登錄入帳：${parts.join('、')}` : '已登錄入帳');
        return;
      }
      if (res.status === 409 && json.code === 'holder_ack_required') {
        const notice = json.notice as HolderNotice & { messageKey: string | null };
        modal.confirm({
          title: '確認押金的收款帳戶持有人',
          content: (
            <Flex vertical gap={token.marginXS}>
              <Typography.Text>{notice.text || (notice.messageKey ? DEPOSIT_HOLDER_MESSAGE_TEXT[notice.messageKey] : '')}</Typography.Text>
              <Typography.Text type="secondary">{RECEIPT_HOLDER_CONFIRM_NOTE}</Typography.Text>
            </Flex>
          ),
          okText: '確認並登錄',
          cancelText: '取消',
          onOk: () => submit(values, true),
        });
        return;
      }
      if (res.status === 422 && json.code === 'holder_blocked') {
        setBlocked(json.notice as HolderNotice);
        return;
      }
      message.error(json.error ?? '登錄失敗');
    } finally {
      setBusy(false);
    }
  };

  const expected = setup.depositLedger?.expectedAmount ?? 0;
  const amountHint =
    purpose === 'rent'
      ? '預設配給最舊的未足額期別，超過的部分記為預收租金。'
      : setup.depositLedger
        ? `約定 ${money(expected)}，累計已收 ${money(setup.depositCollected)}${setup.depositCollected < expected ? `，尚未收足 ${money(expected - setup.depositCollected)}` : ''}。`
        : undefined;

  if (!setup.depositLedger) {
    return (
      <Flex vertical gap="small">
        <SectionTitle>登錄入帳確認</SectionTitle>
        <Typography.Text type="secondary">合約全員簽署完成後才能登錄入帳。</Typography.Text>
      </Flex>
    );
  }

  return (
    <Flex vertical gap="small">
      <SectionTitle>登錄入帳確認</SectionTitle>
      <Typography.Text type="secondary">
        登錄承租人已匯入或交付的款項。金額以銀行紀錄為準，平台只記錄，不經手款項。
      </Typography.Text>
      {blocked && (
        <Alert
          type="error"
          showIcon
          closable={{ onClose: () => setBlocked(null) }}
          title="這個收款帳戶不能收取這個案件的押金"
          description={blocked.text}
        />
      )}
      <Form<FormValues>
        form={form}
        layout="vertical"
        initialValues={{ purpose: 'rent', amount: null, valueDate: dayjs() }}
        onFinish={(values) => void submit(values, false)}
      >
        <Row gutter={token.margin}>
          <Col xs={24} md={6}>
            <Form.Item name="purpose" label="用途">
              <Radio.Group
                optionType="button"
                options={[
                  { value: 'rent', label: RECEIPT_PURPOSE_LABELS.rent },
                  { value: 'security_deposit', label: RECEIPT_PURPOSE_LABELS.security_deposit },
                ]}
                onChange={() => {
                  // 租金與押金的預設帳戶可能不同，換用途時重新預填
                  form.setFieldValue('paymentAccountId', undefined);
                  setBlocked(null);
                }}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={6}>
            <Form.Item name="amount" label="金額" extra={amountHint} rules={[{ required: true, message: '請填寫金額' }]}>
              <InputNumber<number> min={1} precision={0} prefix="$" style={{ width: '100%' }} controls={false} inputMode="numeric" />
            </Form.Item>
          </Col>
          <Col xs={24} md={5}>
            <Form.Item name="valueDate" label="入帳日" rules={[{ required: true, message: '請選擇入帳日' }]}>
              <DatePicker allowClear={false} style={{ width: '100%' }} disabledDate={(current) => current.isAfter(dayjs(), 'day')} />
            </Form.Item>
          </Col>
          <Col xs={24} md={7}>
            <Form.Item name="paymentAccountId" label="收款帳戶" rules={[{ required: true, message: '請選擇收款帳戶' }]}>
              <Select options={options} placeholder="請選擇" showSearch={{ optionFilterProp: 'label' }} notFoundContent="還沒有收款帳戶，請先到收款帳戶頁新增" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item
          name="evidence"
          label="證明檔（選填）"
          valuePropName="fileList"
          getValueFromEvent={(event: { fileList: unknown[] }) => event.fileList}
          extra="匯款單或收據，PDF、JPEG 或 PNG，5 MB 以內。"
        >
          <Upload accept=".pdf,.jpg,.jpeg,.png" maxCount={1} beforeUpload={() => false}>
            <Button>選擇檔案</Button>
          </Upload>
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={busy} disabled={busy}>
          登錄入帳
        </Button>
      </Form>
    </Flex>
  );
}

// --- 入帳紀錄 ---

export function ReceiptsSection({ setup }: { setup: ReceiptsSetup }) {
  return (
    <Flex vertical gap="small">
      <SectionTitle>入帳紀錄</SectionTitle>
      <Table<ReceiptListItem>
        rowKey="id"
        size="small"
        dataSource={setup.receipts}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: '還沒有入帳紀錄' }}
        columns={[
          { title: '入帳日', dataIndex: 'valueDate', width: 110 },
          { title: '用途', width: 70, render: (_, r) => RECEIPT_PURPOSE_LABELS[r.purpose] },
          { title: '金額', width: 110, align: 'right', render: (_, r) => money(r.amount) },
          { title: '收款帳戶', dataIndex: 'accountName' },
          { title: '來源', width: 110, render: (_, r) => <Tag>{receiptSourceLabel(r.source, r.isCash)}</Tag> },
          { title: '登錄者', width: 120, render: (_, r) => r.recordedByName ?? '—' },
          { title: '登錄時間', width: 150, render: (_, r) => formatTaipei(r.recordedAt) },
          {
            title: '備註',
            render: (_, r) => (
              <Flex gap={4} wrap>
                {r.reversed && <Tag>已沖銷</Tag>}
                {r.holderAcknowledged && <Tag color="warning">已確認持有人規則</Tag>}
                {r.evidenceReuseOf && <Tag color="warning">證明檔重複使用</Tag>}
                {r.hasEvidence && !r.evidenceReuseOf && <Tag>已附證明檔</Tag>}
              </Flex>
            ),
          },
        ]}
      />
    </Flex>
  );
}
