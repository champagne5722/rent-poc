'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Flex, Form, Input, Modal, Popconfirm, Radio, Select, Switch, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { ACCOUNT_LAST4_PATTERN, BANK_CODE_PATTERN, HOLDER_KIND_LABELS } from '@/lib/payment-accounts/input';
import type { PaymentAccount } from '@/lib/payment-accounts/repository';

// 收款帳戶（MIL-118）：登錄、修改、停用，並看到每位持有人的現金收取帳戶。
// 只存遮罩識別：銀行代碼與帳號末四碼。account_kind 不顯示，現金收取用標籤表示。
// 持有人是出租人、屋主、代管業者時，從選單挑一位本組織的成員或案件成員（MIL-187），不能自己輸入 ID。
// 選單來自 GET /api/payment-accounts/holder-options，只有顯示名稱與 party ID。
// 持有人是「其他」時沒有 party，維持輸入姓名。

type HolderKind = PaymentAccount['holderKind'];

interface FormValues {
  name: string;
  method: 'bank' | 'cash';
  holderKind: HolderKind;
  /** 持有人的 party，來自選單。持有人是「其他」時沒有。 */
  holderPartyId?: string;
  holderName: string;
  bankCode?: string;
  accountLast4?: string;
}

/** 編輯器的目標：新增（可帶預設值），或修改既有帳戶。 */
type EditorTarget = { kind: 'new'; preset?: Partial<FormValues> } | { kind: 'edit'; account: PaymentAccount };

const HOLDER_OPTIONS = (Object.keys(HOLDER_KIND_LABELS) as HolderKind[]).map((value) => ({
  value,
  label: HOLDER_KIND_LABELS[value],
}));

const EMPTY_VALUES: FormValues = { name: '', method: 'bank', holderKind: 'lessor', holderName: '' };

function initialValues(target: EditorTarget): FormValues {
  if (target.kind === 'new') return { ...EMPTY_VALUES, ...target.preset };
  const a = target.account;
  return {
    name: a.name,
    method: a.isCash ? 'cash' : 'bank',
    holderKind: a.holderKind,
    holderPartyId: a.holderPartyId ?? undefined,
    holderName: a.holderName,
    bankCode: a.bankCode ?? undefined,
    accountLast4: a.accountLast4 ?? undefined,
  };
}

interface HolderOption {
  partyId: string;
  displayName: string;
}

type HolderOptionsState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; options: HolderOption[]; selfPartyId: string | null };

interface EditorProps {
  target: EditorTarget | null;
  onClose: () => void;
  onSaved: () => void;
  onDeactivateAndAdd: (account: PaymentAccount) => void;
}

// 表單放在自己的元件裡，Modal 打開才掛載：每次開啟都是乾淨的初始值，也不需要 forceRender
function AccountEditor({ target, onClose, onSaved, onDeactivateAndAdd }: EditorProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);
  const method = Form.useWatch('method', form);
  const holderKind = Form.useWatch('holderKind', form);

  const account = target?.kind === 'edit' ? target.account : null;
  const isNew = target?.kind === 'new';
  const locked = account?.locked ?? false;
  const isCash = (method ?? (target ? initialValues(target).method : 'bank')) === 'cash';
  const isOpen = target !== null;

  // 編輯器打開時才載入持有人選單。新增時，沒有預設持有人就帶入目前登入者
  const [holders, setHolders] = useState<HolderOptionsState>({ status: 'loading' });
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void fetch('/api/payment-accounts/holder-options')
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setHolders({ status: 'error' });
          return;
        }
        const body = (await res.json()) as { data: HolderOption[]; selfPartyId: string | null };
        if (cancelled) return;
        setHolders({ status: 'ready', options: body.data, selfPartyId: body.selfPartyId });
        const current = form.getFieldsValue(['holderKind', 'holderPartyId']) as Pick<FormValues, 'holderKind' | 'holderPartyId'>;
        const self = body.data.find((o) => o.partyId === body.selfPartyId);
        if (isNew && self && current.holderKind !== 'other' && !current.holderPartyId) {
          form.setFieldsValue({ holderPartyId: self.partyId, holderName: self.displayName });
        }
      })
      .catch(() => {
        if (!cancelled) setHolders({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, isNew, form]);

  // 既有帳戶的持有人可能已不在清單內（例如離開組織）。把他補成選項，畫面才顯示名稱而不是 ID
  const holderOptions = useMemo(() => {
    const options = (holders.status === 'ready' ? holders.options : []).map((o) => ({ value: o.partyId, label: o.displayName }));
    if (account?.holderPartyId && !options.some((o) => o.value === account.holderPartyId)) {
      options.unshift({ value: account.holderPartyId, label: account.holderName });
    }
    return options;
  }, [holders, account]);

  // 種類在「其他」與其他種類之間切換時，持有人欄位換一種填法，舊的值不留下來
  const onValuesChange = (changed: Partial<FormValues>) => {
    if (changed.holderKind === undefined) return;
    if (changed.holderKind === 'other') {
      form.setFieldsValue({ holderPartyId: undefined, holderName: '' });
      return;
    }
    if (holders.status === 'ready' && !form.getFieldValue('holderPartyId')) {
      const self = holders.options.find((o) => o.partyId === holders.selfPartyId);
      form.setFieldsValue({ holderPartyId: self?.partyId, holderName: self?.displayName ?? '' });
    }
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    const res = await fetch(account ? `/api/payment-accounts/${account.id}` : '/api/payment-accounts', {
      method: account ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    setSaving(false);
    if (!res.ok) {
      message.error((await res.json()).error ?? '儲存失敗');
      return;
    }
    message.success(isNew ? '收款帳戶已登錄' : '收款帳戶已更新');
    onSaved();
  };

  return (
    <Modal
      title={isNew ? '新增收款帳戶' : '編輯收款帳戶'}
      open={target !== null}
      onOk={() => void save()}
      onCancel={onClose}
      okText="儲存"
      cancelText="取消"
      confirmLoading={saving}
      destroyOnHidden
    >
      {target && (
        <Form form={form} layout="vertical" initialValues={initialValues(target)} onValuesChange={onValuesChange}>
          {locked && account && (
            <Form.Item>
              <Alert
                type="warning"
                showIcon
                title="這個帳戶已有分錄引用"
                description="持有人與銀行帳號末四碼不得修改，只能改名稱。要換持有人或帳號，請停用並新增。"
                action={
                  <Button size="small" onClick={() => onDeactivateAndAdd(account)}>
                    停用並新增
                  </Button>
                }
              />
            </Form.Item>
          )}
          <Form.Item name="name" label="帳戶名稱" rules={[{ required: true, whitespace: true, message: '請輸入帳戶名稱' }]}>
            <Input maxLength={60} placeholder="例：王先生的台新帳戶" />
          </Form.Item>
          <Form.Item name="method" label="收款方式">
            <Radio.Group disabled={!isNew}>
              <Radio value="bank">銀行帳戶</Radio>
              <Radio value="cash">現金收取</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="holderKind" label="持有人種類" rules={[{ required: true }]}>
            <Select options={HOLDER_OPTIONS} disabled={locked} />
          </Form.Item>
          {holderKind === 'other' ? (
            <Form.Item
              name="holderName"
              label="持有人姓名"
              rules={[{ required: true, whitespace: true, message: '請輸入持有人姓名' }]}
              extra="這個人不是本組織的成員，只記姓名。系統會替每位持有人保留一個現金收取帳戶。"
            >
              <Input maxLength={60} disabled={locked} />
            </Form.Item>
          ) : (
            <>
              <Form.Item
                name="holderPartyId"
                label="持有人"
                rules={[{ required: true, message: '請選擇持有人' }]}
                validateStatus={holders.status === 'error' ? 'error' : undefined}
                help={holders.status === 'error' ? '無法載入成員清單，請關閉後重新開啟' : undefined}
                extra={
                  holders.status === 'ready' && holderOptions.length === 0
                    ? '目前沒有可選的成員。'
                    : '只能選本組織的成員與案件成員。系統會替每位持有人保留一個現金收取帳戶。'
                }
              >
                <Select
                  showSearch={{ optionFilterProp: 'label' }}
                  placeholder="選擇持有人"
                  loading={holders.status === 'loading'}
                  disabled={locked}
                  options={holderOptions}
                  notFoundContent="沒有符合的成員"
                  onChange={(_value, option) => {
                    const picked = Array.isArray(option) ? option[0] : option;
                    form.setFieldsValue({ holderName: typeof picked?.label === 'string' ? picked.label : '' });
                  }}
                />
              </Form.Item>
              {/* 持有人名稱跟著選單走，不另外輸入 */}
              <Form.Item name="holderName" hidden>
                <Input />
              </Form.Item>
            </>
          )}
          {isCash ? (
            <Typography.Paragraph type="secondary">現金收取沒有銀行紀錄，不參與對帳檔比對。</Typography.Paragraph>
          ) : (
            <Flex gap={12}>
              <Form.Item
                name="bankCode"
                label="銀行代碼"
                style={{ flex: 1 }}
                rules={[{ required: true, pattern: BANK_CODE_PATTERN, message: '請輸入 3 碼銀行代碼，或含分行的 7 碼' }]}
              >
                <Input inputMode="numeric" maxLength={7} placeholder="例：812" disabled={locked} />
              </Form.Item>
              <Form.Item
                name="accountLast4"
                label="帳號末四碼"
                style={{ flex: 1 }}
                rules={[{ required: true, pattern: ACCOUNT_LAST4_PATTERN, message: '請輸入帳號末 4 碼' }]}
                extra="只填末四碼，請勿輸入完整帳號。"
              >
                <Input inputMode="numeric" maxLength={4} placeholder="例：0123" disabled={locked} />
              </Form.Item>
            </Flex>
          )}
        </Form>
      )}
    </Modal>
  );
}

function PaymentAccountsPage() {
  const { message, modal } = AntApp.useApp();
  const [items, setItems] = useState<PaymentAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  // 每次開啟編輯器都換一個 key：表單實例會保留上一次的值，不換的話「停用並新增」帶入的預設值會被舊值蓋掉
  const [editorSeq, setEditorSeq] = useState(0);
  const openEditor = (target: EditorTarget) => {
    setEditorSeq((n) => n + 1);
    setEditor(target);
  };

  // 載入只在 effect 的非同步回呼裡改狀態；儲存或停用後遞增 reloadKey 重新載入
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/payment-accounts')
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) setItems((await res.json()).data);
        else message.error('無法載入收款帳戶');
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        message.error('無法載入收款帳戶');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, message]);

  // 同一位持有人的帳戶排在一起，銀行帳戶在前、現金收取在後
  const rows = useMemo(
    () =>
      items
        .filter((a) => showInactive || a.active)
        .sort((a, b) => a.holderName.localeCompare(b.holderName) || Number(a.isCash) - Number(b.isCash) || b.id.localeCompare(a.id)),
    [items, showInactive],
  );

  const deactivate = async (id: string): Promise<boolean> => {
    const res = await fetch(`/api/payment-accounts/${id}/deactivate`, { method: 'POST' });
    if (!res.ok) {
      message.error((await res.json()).error ?? '停用失敗');
      return false;
    }
    message.success('收款帳戶已停用');
    reload();
    return true;
  };

  // 已有分錄引用的帳戶：停用舊的，帶著同一位持有人開新增表單
  const deactivateAndAdd = (account: PaymentAccount) => {
    modal.confirm({
      title: '停用這個帳戶並新增一個？',
      content: '停用後，這個帳戶不能再收款，既有的紀錄會保留。接著會帶入同一位持有人，讓你新增新的帳戶。',
      okText: '停用並新增',
      cancelText: '取消',
      onOk: async () => {
        if (!(await deactivate(account.id))) return;
        openEditor({
          kind: 'new',
          preset: {
            holderKind: account.holderKind,
            holderPartyId: account.holderPartyId ?? undefined,
            holderName: account.holderName,
            method: 'bank',
          },
        });
      },
    });
  };

  return (
    <Flex vertical gap={24}>
      <Flex justify="space-between" align="center" gap={16} wrap>
        <Flex vertical gap={4}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            收款帳戶
          </Typography.Title>
          <Typography.Text type="secondary">只記帳戶名稱、銀行代碼與帳號末四碼。平台不經手款項。</Typography.Text>
        </Flex>
        <Flex align="center" gap={16} wrap>
          <Flex align="center" gap={8}>
            <Switch size="small" checked={showInactive} onChange={setShowInactive} aria-label="顯示已停用的帳戶" />
            <Typography.Text type="secondary" style={{ whiteSpace: 'nowrap' }}>
              顯示已停用
            </Typography.Text>
          </Flex>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor({ kind: 'new' })}>
            新增收款帳戶
          </Button>
        </Flex>
      </Flex>

      <Table<PaymentAccount>
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: '尚無收款帳戶，點右上角「新增收款帳戶」開始' }}
        columns={[
          { title: '名稱', dataIndex: 'name' },
          {
            title: '持有人',
            render: (_, a) => (
              <Flex align="center" gap={8}>
                <Tag>{HOLDER_KIND_LABELS[a.holderKind]}</Tag>
                <span>{a.holderName}</span>
              </Flex>
            ),
          },
          {
            title: '收款方式',
            render: (_, a) =>
              a.isCash ? <Tag color="processing">現金收取</Tag> : <span>{`${a.bankCode}　末四碼 ${a.accountLast4}`}</span>,
          },
          {
            title: '狀態',
            width: 100,
            render: (_, a) => (a.active ? <Tag color="success">使用中</Tag> : <Tag>已停用</Tag>),
          },
          {
            title: '操作',
            width: 140,
            render: (_, a) =>
              a.active ? (
                <Flex gap={8}>
                  <Button type="link" size="small" onClick={() => openEditor({ kind: 'edit', account: a })}>
                    編輯
                  </Button>
                  <Popconfirm
                    title="停用這個收款帳戶？"
                    description="停用後不能再收款，既有的紀錄會保留。"
                    okText="停用"
                    cancelText="取消"
                    onConfirm={() => void deactivate(a.id)}
                  >
                    <Button type="link" size="small" danger>
                      停用
                    </Button>
                  </Popconfirm>
                </Flex>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
        ]}
      />

      <AccountEditor
        key={editorSeq}
        target={editor}
        onClose={() => setEditor(null)}
        onSaved={() => {
          setEditor(null);
          reload();
        }}
        onDeactivateAndAdd={(account) => {
          setEditor(null);
          deactivateAndAdd(account);
        }}
      />
    </Flex>
  );
}

export default function Page() {
  return (
    <AntApp>
      <PaymentAccountsPage />
    </AntApp>
  );
}
