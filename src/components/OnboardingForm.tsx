'use client';

import { useState } from 'react';
import { Alert, Button, Checkbox, Flex, Form, Input, Radio, Typography, theme } from 'antd';
import { statutoryTitle, type LicenseKind } from '@/lib/labels';
import { ORG_NAME_MAX } from '@/lib/orgs/onboarding-rules';
import LogoutButton from './LogoutButton';

// 第一次登入、帳號還沒有任何身分時的畫面（MIL-106，ADR-0022 決議 4）：
// 選「我是屋主」建屋主組織，或選「我是經理人」填統編、組織型態與業別，建執業主體組織與待驗證的業別。
// 放在登入頁的卡片內（/login?notice=no-identity）。經理人的送出結果一律顯示「已送出」，
// 不論統編是第一次登錄還是已被別的組織登錄，畫面不透露差別。

type Step = 'choose' | 'owner' | 'practice' | 'submitted';

interface ApiResult {
  ok: boolean;
  body: { error?: string; field?: string; code?: string; data?: { redirectTo?: string } };
}

async function post(url: string, body: unknown): Promise<ApiResult> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: response.ok, body: ((await response.json().catch(() => ({}))) as ApiResult['body']) ?? {} };
}

const KIND_OPTIONS: Array<{ value: LicenseKind; companyOnly: boolean }> = [
  { value: 'management', companyOnly: true },
  { value: 'master_lease', companyOnly: true },
  { value: 'brokerage', companyOnly: false },
];

// Form.Item 注入 value 與 onChange。用 Flex 排列，不寫死間距
function KindCheckboxes({ value = [], onChange, firmSelected }: { value?: LicenseKind[]; onChange?: (next: LicenseKind[]) => void; firmSelected: boolean }) {
  return (
    <Flex vertical gap="small">
      {KIND_OPTIONS.map((option) => (
        <Checkbox
          key={option.value}
          checked={value.includes(option.value)}
          disabled={option.companyOnly && firmSelected}
          onChange={(e) => onChange?.(e.target.checked ? [...value, option.value] : value.filter((k) => k !== option.value))}
        >
          {statutoryTitle(option.value)}
        </Checkbox>
      ))}
    </Flex>
  );
}

const FIELD_NAMES = new Set(['name', 'taxId', 'entityType', 'kinds']);

export default function OnboardingForm() {
  const [step, setStep] = useState<Step>('choose');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redirectTo, setRedirectTo] = useState('/');
  const { token } = theme.useToken();
  const [form] = Form.useForm();
  const entityType = Form.useWatch('entityType', form) as 'company' | 'firm' | undefined;

  function back() {
    setStep('choose');
    setError(null);
    form.resetFields();
  }

  async function submit(url: string, values: Record<string, unknown>, onOk: (to: string) => void) {
    setLoading(true);
    setError(null);
    try {
      const result = await post(url, values);
      if (result.ok) {
        onOk(result.body.data?.redirectTo ?? '/');
        return;
      }
      const message = result.body.error ?? '建立失敗，請稍後再試';
      if (result.body.field && FIELD_NAMES.has(result.body.field)) form.setFields([{ name: result.body.field, errors: [message] }]);
      else setError(message);
    } catch {
      setError('網路發生問題，請稍後再試');
    }
    setLoading(false);
  }

  if (step === 'submitted') {
    return (
      <Flex vertical gap="middle">
        <Alert
          type="success"
          showIcon
          title="已送出登錄"
          description="平台營運者核對業別後才會開通。核對結果會顯示在工作台。"
        />
        <Button type="primary" block onClick={() => window.location.assign(redirectTo)}>
          進入工作台
        </Button>
      </Flex>
    );
  }

  if (step === 'choose') {
    return (
      <Flex vertical gap="middle">
        <Typography.Text>這個帳號還沒有加入任何組織。請選擇你的身分，我們會建立第一個組織。</Typography.Text>
        <Flex vertical gap="small">
          <Button size="large" block style={{ height: 'auto', padding: `${token.paddingSM}px ${token.padding}px`, justifyContent: 'flex-start', textAlign: 'start' }} onClick={() => setStep('owner')}>
            <Flex vertical align="flex-start">
              <Typography.Text strong>我是屋主</Typography.Text>
              <Typography.Text type="secondary">管理自己的物件與出租合約</Typography.Text>
            </Flex>
          </Button>
          <Button size="large" block style={{ height: 'auto', padding: `${token.paddingSM}px ${token.padding}px`, justifyContent: 'flex-start', textAlign: 'start' }} onClick={() => setStep('practice')}>
            <Flex vertical align="flex-start">
              <Typography.Text strong>我是經理人</Typography.Text>
              <Typography.Text type="secondary">以代管、包租或經紀業者的名義執業</Typography.Text>
            </Flex>
          </Button>
        </Flex>
        <Typography.Text type="secondary">受邀加入別人的組織？請先請管理員用這個 email 邀請你，再登入一次。</Typography.Text>
        <LogoutButton type="default" label="登出並改用其他 email" />
      </Flex>
    );
  }

  const isOwner = step === 'owner';
  return (
    <Form
      form={form}
      layout="vertical"
      requiredMark={false}
      initialValues={{ entityType: 'company', kinds: [] }}
      onFinish={(values: Record<string, unknown>) =>
        void submit(
          isOwner ? '/api/onboarding/owner' : '/api/onboarding/practice',
          values,
          (to) => {
            if (isOwner) window.location.assign(to);
            else {
              setRedirectTo(to);
              setStep('submitted');
            }
          },
        )
      }
    >
      <Flex vertical gap="middle">
        <Typography.Title level={5} style={{ margin: 0 }}>
          {isOwner ? '建立屋主組織' : '登錄執業主體'}
        </Typography.Title>
        {error && <Alert type="error" showIcon title={error} />}

        <Form.Item
          label={isOwner ? '組織名稱' : '公司或商號名稱'}
          name="name"
          style={{ margin: 0 }}
          rules={[{ required: true, whitespace: true, message: '請輸入名稱' }, { max: ORG_NAME_MAX, message: `名稱不得超過 ${ORG_NAME_MAX} 字` }]}
        >
          <Input autoFocus autoComplete="organization" placeholder={isOwner ? '例如：王小明的屋主組織' : '例如：安心代管有限公司'} />
        </Form.Item>

        {!isOwner && (
          <>
            <Form.Item
              label="統一編號"
              name="taxId"
              style={{ margin: 0 }}
              rules={[{ required: true, message: '請輸入統一編號' }, { pattern: /^\s*\d{8}\s*$/, message: '統一編號是 8 碼數字' }]}
            >
              <Input inputMode="numeric" maxLength={8} placeholder="8 碼數字" />
            </Form.Item>
            <Form.Item label="組織型態" name="entityType" style={{ margin: 0 }}>
              <Radio.Group
                options={[
                  { value: 'company', label: '公司' },
                  { value: 'firm', label: '商號' },
                ]}
                onChange={(e) => {
                  if (e.target.value === 'firm') {
                    // 商號不能登錄代管與包租，切換時順手取消
                    const kept = ((form.getFieldValue('kinds') as LicenseKind[]) ?? []).filter((k) => k === 'brokerage');
                    form.setFieldValue('kinds', kept);
                  }
                }}
              />
            </Form.Item>
            <Form.Item
              label="業別"
              name="kinds"
              style={{ margin: 0 }}
              extra={entityType === 'firm' ? '租賃住宅代管與包租限公司登錄，商號只能登錄不動產經紀業。' : undefined}
              rules={[{ required: true, type: 'array', min: 1, message: '請至少選一種業別' }]}
            >
              <KindCheckboxes firmSelected={entityType === 'firm'} />
            </Form.Item>
          </>
        )}

        <Flex gap="small">
          <Button type="primary" htmlType="submit" loading={loading}>
            {isOwner ? '建立屋主組織' : '送出登錄'}
          </Button>
          <Button onClick={back} disabled={loading}>
            返回
          </Button>
        </Flex>
      </Flex>
    </Form>
  );
}
