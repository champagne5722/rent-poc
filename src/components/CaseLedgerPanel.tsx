'use client';

import { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Alert, Button, Col, Descriptions, Flex, Form, Input, Modal, Popconfirm, Row, Select, Spin, Table, Tag, Typography, theme } from 'antd';
import type { DepositLedger, HolderConflict, PeriodRecord, RemitterId, SocialHousingChange } from '@/lib/case-ledger';
import { formatTaipei } from '@/lib/case-display';
import {
  DEPOSIT_HOLDER_MESSAGE_TEXT,
  DEPOSIT_LEDGER_STATUS_LABELS,
  PERIOD_STATE_LABELS,
  REMITTER_KIND_LABELS,
  SOCIAL_HOUSING_LABELS,
} from '@/lib/labels/case-ledger-labels';
import { HOLDER_KIND_LABELS } from '@/lib/payment-accounts/input';

// 案件的帳務設定分頁（MIL-123）：社宅代管旗標、押金台帳、應收期別、匯款識別、預設收款帳戶。
// 只做設定與唯讀的清單。入帳確認、配置與沖銷的畫面屬 MIL-125，期別的未入帳與已入帳狀態等配置建好才有。
// 編輯控制項由 API 回傳的 canConfigure、canSetSocialHousing 決定，真正的檢查在各個寫入的 route。

interface LedgerSetup {
  socialHousing: boolean;
  canConfigure: boolean;
  canSetSocialHousing: boolean;
  depositLedger: DepositLedger | null;
  depositBalance: number;
  periods: PeriodRecord[];
  remitterIds: RemitterId[];
  defaultAccounts: { rentAccountId: string | null; depositAccountId: string | null } | null;
  socialHousingChanges: SocialHousingChange[];
  holderConflicts: HolderConflict[];
}

interface AccountOption {
  id: string;
  name: string;
  holderKind: keyof typeof HOLDER_KIND_LABELS;
  holderName: string;
  isCash: boolean;
  active: boolean;
}

type Load = { status: 'loading' } | { status: 'forbidden' } | { status: 'ready'; setup: LedgerSetup };

const money = (n: number) => `$${n.toLocaleString('zh-TW')}`;

export default function CaseLedgerPanel({ caseId }: { caseId: string }) {
  const { message } = AntApp.useApp();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [accounts, setAccounts] = useState<AccountOption[]>([]);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/cases/${caseId}/ledger`);
    if (!res.ok) return setLoad({ status: 'forbidden' });
    setLoad({ status: 'ready', setup: (await res.json()).data });
  }, [caseId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 載入資料後設定狀態是這個元件的用途
    void refresh();
  }, [refresh]);

  const canConfigure = load.status === 'ready' && load.setup.canConfigure;
  useEffect(() => {
    // 預設收款帳戶的選單要用到帳戶清單。只有能編輯的人才需要
    if (!canConfigure) return;
    void fetch('/api/payment-accounts')
      .then((res) => (res.ok ? res.json() : { data: [] }))
      .then((json) => setAccounts(json.data as AccountOption[]));
  }, [canConfigure]);

  if (load.status === 'loading') {
    return (
      <Flex justify="center">
        <Spin />
      </Flex>
    );
  }
  if (load.status === 'forbidden') {
    return <Alert type="info" showIcon message="你看不到這個案件的帳務設定" />;
  }

  const { setup } = load;
  const onChanged = async (text: string) => {
    message.success(text);
    await refresh();
  };

  return (
    <Flex vertical gap="large">
      <SocialHousingSection caseId={caseId} setup={setup} onChanged={onChanged} />
      <DepositSection setup={setup} />
      <PeriodsSection periods={setup.periods} hasLedger={setup.depositLedger !== null} />
      <RemitterSection caseId={caseId} setup={setup} onChanged={onChanged} />
      <DefaultAccountsSection caseId={caseId} setup={setup} accounts={accounts} onChanged={onChanged} />
    </Flex>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Typography.Text strong>{children}</Typography.Text>
  );
}

// --- 社宅代管旗標 ---

function SocialHousingSection({ caseId, setup, onChanged }: { caseId: string; setup: LedgerSetup; onChanged: (text: string) => Promise<void> }) {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<{ reason: string }>();
  const next = !setup.socialHousing;

  const submit = async ({ reason }: { reason: string }) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/social-housing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: next, reason }),
      });
      const json = await res.json();
      if (!res.ok) {
        message.error(json.error ?? '修改失敗');
        return;
      }
      setOpen(false);
      form.resetFields();
      await onChanged(json.data.mandatorNotified ? '已修改，並通知委託人' : '已修改');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex vertical gap="small">
      <SectionTitle>社宅代管旗標</SectionTitle>
      <Flex align="center" gap="small" wrap>
        <Tag color={setup.socialHousing ? 'processing' : 'default'}>
          {setup.socialHousing ? SOCIAL_HOUSING_LABELS.yes : SOCIAL_HOUSING_LABELS.no}
        </Tag>
        {setup.canSetSocialHousing && (
          <Button size="small" onClick={() => setOpen(true)}>
            {next ? '改為社宅代管案件' : '改為非社宅代管案件'}
          </Button>
        )}
      </Flex>
      {setup.socialHousing && setup.holderConflicts.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="押金的持有人與社宅代管案件的規則衝突"
          description={
            <Flex vertical gap={token.marginXXS}>
              {setup.holderConflicts.map((c) => (
                <Typography.Text key={c.paymentAccountId}>
                  {`${HOLDER_KIND_LABELS[c.holderKind]}「${c.accountName}」累計收取押金 ${money(c.collectedAmount)}。${c.messageKey ? (DEPOSIT_HOLDER_MESSAGE_TEXT[c.messageKey] ?? '') : ''}`}
                </Typography.Text>
              ))}
              <Typography.Text type="secondary">既有的押金分錄不會更動。之後的押金入帳會依新規則檢查。</Typography.Text>
            </Flex>
          }
        />
      )}
      {setup.socialHousingChanges.length > 0 && (
        <Table<SocialHousingChange>
          rowKey="id"
          size="small"
          dataSource={setup.socialHousingChanges}
          pagination={false}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: '修改時間', width: 160, render: (_, c) => formatTaipei(c.changedAt) },
            { title: '改為', width: 160, render: (_, c) => (c.toValue ? SOCIAL_HOUSING_LABELS.yes : SOCIAL_HOUSING_LABELS.no) },
            { title: '原因', dataIndex: 'reason' },
          ]}
        />
      )}
      <Modal
        open={open}
        title={next ? '改為社宅代管案件' : '改為非社宅代管案件'}
        okText="確認修改"
        cancelText="取消"
        confirmLoading={busy}
        onOk={() => form.submit()}
        onCancel={() => setOpen(false)}
        destroyOnHidden
      >
        <Flex vertical gap="small">
          <Typography.Text>
            修改會寫入紀錄，並通知委託人。既有的押金分錄不會更動，之後的押金入帳依
            {next ? '社宅代管案件' : '一般代管案件'}
            的規則檢查。
          </Typography.Text>
          <Form form={form} layout="vertical" onFinish={(values) => void submit(values)}>
            <Form.Item name="reason" label="修改原因" rules={[{ required: true, whitespace: true, message: '請填寫修改原因' }]}>
              <Input.TextArea rows={3} maxLength={500} showCount />
            </Form.Item>
          </Form>
        </Flex>
      </Modal>
    </Flex>
  );
}

// --- 押金台帳 ---

function DepositSection({ setup }: { setup: LedgerSetup }) {
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
            { key: 'balance', label: '目前餘額', children: money(setup.depositBalance) },
            { key: 'status', label: '狀態', children: DEPOSIT_LEDGER_STATUS_LABELS[ledger.status] },
            { key: 'created', label: '建立時間', children: formatTaipei(ledger.createdAt) },
          ]}
        />
      )}
    </Flex>
  );
}

// --- 應收期別 ---

function PeriodsSection({ periods, hasLedger }: { periods: PeriodRecord[]; hasLedger: boolean }) {
  return (
    <Flex vertical gap="small">
      <SectionTitle>應收期別</SectionTitle>
      <Table<PeriodRecord>
        rowKey="id"
        size="small"
        dataSource={periods}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{
          emptyText: hasLedger ? '合約欄位不足（缺少月租、付款日或有效的租期），系統沒有產生應收期別。' : '合約全員簽署完成後才會產生',
        }}
        columns={[
          { title: '期別', dataIndex: 'periodKey', width: 100 },
          { title: '涵蓋日期', width: 220, render: (_, p) => `${p.periodStart} 至 ${p.periodEnd}` },
          { title: '到期日', dataIndex: 'dueDate', width: 120 },
          { title: '應收金額', width: 120, align: 'right', render: (_, p) => money(p.amount) },
          {
            title: '狀態',
            width: 110,
            render: (_, p) =>
              p.state === 'cancelled' ? (
                <Tag>{PERIOD_STATE_LABELS.cancelled}</Tag>
              ) : p.overdueAt ? (
                <Tag color="error">逾期</Tag>
              ) : (
                PERIOD_STATE_LABELS.active
              ),
          },
        ]}
      />
    </Flex>
  );
}

// --- 匯款識別 ---

function RemitterSection({ caseId, setup, onChanged }: { caseId: string; setup: LedgerSetup; onChanged: (text: string) => Promise<void> }) {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const [form] = Form.useForm<{ kind: RemitterId['kind']; value: string }>();
  const [busy, setBusy] = useState(false);
  const kind = Form.useWatch('kind', form) ?? 'payer_name';

  const add = async (values: { kind: RemitterId['kind']; value: string }) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/remitter-ids`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (!res.ok) {
        message.error(json.error ?? '登錄失敗');
        return;
      }
      form.setFieldsValue({ value: '' });
      await onChanged('已登錄匯款識別');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/cases/${caseId}/remitter-ids/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      message.error((await res.json()).error ?? '移除失敗');
      return;
    }
    await onChanged('已移除匯款識別');
  };

  return (
    <Flex vertical gap="small">
      <SectionTitle>匯款識別</SectionTitle>
      <Typography.Text type="secondary">
        登錄承租人匯款時的付款人戶名或付款帳號末五碼，匯入對帳檔時系統依它自動配對。沒有登錄時，所有款項都進待配對清單。
      </Typography.Text>
      <Table<RemitterId>
        rowKey="id"
        size="small"
        dataSource={setup.remitterIds}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: '還沒有登錄匯款識別' }}
        columns={[
          { title: '種類', width: 160, render: (_, r) => REMITTER_KIND_LABELS[r.kind] },
          { title: '內容', dataIndex: 'value' },
          { title: '登錄時間', width: 160, render: (_, r) => formatTaipei(r.createdAt) },
          ...(setup.canConfigure
            ? [
                {
                  title: '操作',
                  width: 100,
                  render: (_: unknown, r: RemitterId) => (
                    <Popconfirm title="移除這筆匯款識別？" okText="移除" cancelText="取消" onConfirm={() => void remove(r.id)}>
                      <Button type="link" size="small" danger>
                        移除
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]
            : []),
        ]}
      />
      {setup.canConfigure && (
        <Form form={form} layout="vertical" initialValues={{ kind: 'payer_name', value: '' }} onFinish={(values) => void add(values)}>
          <Row gutter={token.margin}>
            <Col xs={24} md={8}>
              <Form.Item name="kind" label="種類">
                <Select
                  options={Object.entries(REMITTER_KIND_LABELS).map(([value, label]) => ({ value, label }))}
                  onChange={() => form.setFieldsValue({ value: '' })}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={10}>
              <Form.Item name="value" label="內容" rules={[{ required: true, whitespace: true, message: '請填寫內容' }]}>
                <Input
                  maxLength={kind === 'payer_name' ? 60 : 5}
                  placeholder={kind === 'payer_name' ? '例如：王大明' : '5 位數字'}
                  inputMode={kind === 'payer_name' ? 'text' : 'numeric'}
                />
              </Form.Item>
            </Col>
          </Row>
          <Button type="primary" htmlType="submit" loading={busy}>
            新增
          </Button>
        </Form>
      )}
    </Flex>
  );
}

// --- 預設收款帳戶 ---

function DefaultAccountsSection({
  caseId,
  setup,
  accounts,
  onChanged,
}: {
  caseId: string;
  setup: LedgerSetup;
  accounts: AccountOption[];
  onChanged: (text: string) => Promise<void>;
}) {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const current = setup.defaultAccounts ?? { rentAccountId: null, depositAccountId: null };
  const [form] = Form.useForm<{ rentAccountId: string | null; depositAccountId: string | null }>();
  const [busy, setBusy] = useState(false);

  const nameOf = (id: string | null) => {
    if (id === null) return '未設定';
    const found = accounts.find((a) => a.id === id);
    return found ? found.name : '（帳戶已停用或你看不到）';
  };
  const options = accounts
    .filter((a) => a.active)
    .map((a) => ({ value: a.id, label: `${a.name}（${a.isCash ? '現金收取' : HOLDER_KIND_LABELS[a.holderKind]}）` }));

  const save = async (values: { rentAccountId?: string | null; depositAccountId?: string | null }) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/default-accounts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rentAccountId: values.rentAccountId ?? null, depositAccountId: values.depositAccountId ?? null }),
      });
      const json = await res.json();
      if (!res.ok) {
        message.error(json.error ?? '儲存失敗');
        return;
      }
      await onChanged('已儲存預設收款帳戶');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex vertical gap="small">
      <SectionTitle>預設收款帳戶</SectionTitle>
      <Typography.Text type="secondary">登錄入帳時，系統用這裡的帳戶預填表單。不影響已登錄的帳務。</Typography.Text>
      {setup.canConfigure ? (
        <Form
          form={form}
          layout="vertical"
          // key 讓載入完成或儲存後的最新值重新帶入表單
          key={`${current.rentAccountId}:${current.depositAccountId}`}
          initialValues={current}
          onFinish={(values) => void save(values)}
        >
          <Row gutter={token.margin}>
            <Col xs={24} md={9}>
              <Form.Item name="rentAccountId" label="租金">
                <Select allowClear placeholder="未設定" options={options} />
              </Form.Item>
            </Col>
            <Col xs={24} md={9}>
              <Form.Item name="depositAccountId" label="押金">
                <Select allowClear placeholder="未設定" options={options} />
              </Form.Item>
            </Col>
          </Row>
          <Button type="primary" htmlType="submit" loading={busy}>
            儲存
          </Button>
        </Form>
      ) : (
        <Descriptions
          column={1}
          size="small"
          bordered
          items={[
            { key: 'rent', label: '租金', children: nameOf(current.rentAccountId) },
            { key: 'deposit', label: '押金', children: nameOf(current.depositAccountId) },
          ]}
        />
      )}
    </Flex>
  );
}
