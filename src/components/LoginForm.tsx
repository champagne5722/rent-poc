'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Flex, Form, Input, Row, Typography, theme } from 'antd';
import { AUTH_CONFIG } from '@/lib/auth/config';
import OnboardingForm from './OnboardingForm';

// 登入頁（MIL-103，ADR-0022）：兩步。第一步輸入 email 寄驗證碼，第二步輸入 6 碼驗證碼。
// 通過驗證但還沒有身分的帳號，在同一張卡片內選屋主或經理人建第一個組織（MIL-106）。
// 不論 email 有沒有帳號，第一步的回應與畫面都相同。驗證碼錯誤、過期、用過、錯太多次，畫面訊息也相同。

// 數字取自 src/lib/auth/config.ts（假設值）
const OTP_LENGTH = AUTH_CONFIG.otpLength;
const RESEND_SECONDS = Math.round(AUTH_CONFIG.otpResendIntervalMs / 1000);

type Step = 'email' | 'code';

interface ApiBody {
  error?: string;
  retryAfterSec?: number;
  data?: { redirectTo?: string };
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; body: ApiBody }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as ApiBody;
  return { ok: response.ok, status: response.status, body: json };
}

export default function LoginForm({ next, noIdentity }: { next: string; noIdentity: boolean }) {
  const { token } = theme.useToken();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  async function sendCode(address: string) {
    setLoading(true);
    setError(null);
    try {
      const result = await postJson('/api/auth/otp', { email: address });
      if (result.ok) {
        setEmail(address);
        setStep('code');
        setSecondsLeft(RESEND_SECONDS);
      } else {
        setError(typeof result.body.error === 'string' ? result.body.error : '驗證碼寄送失敗，請稍後再試');
        if (result.status === 429 && typeof result.body.retryAfterSec === 'number') setSecondsLeft(result.body.retryAfterSec);
      }
    } catch {
      setError('網路發生問題，請稍後再試');
    } finally {
      setLoading(false);
    }
  }

  async function verify(code: string) {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await postJson('/api/auth/verify', { email, code });
      if (result.ok) {
        const redirectTo = result.body.data?.redirectTo;
        // 網址有明確的 ?next= 時回到那裡；否則依身分落地（只有屋主身分到 /owner，MIL-106）。沒有身分的帳號留在登入頁建組織
        window.location.assign(next !== '/' ? next : typeof redirectTo === 'string' ? redirectTo : '/');
        return;
      }
      setError(typeof result.body.error === 'string' ? result.body.error : '登入失敗，請重新輸入');
    } catch {
      setError('網路發生問題，請稍後再試');
    }
    setLoading(false);
  }

  return (
    <Row
      justify="center"
      align="middle"
      style={{ minHeight: '100vh', padding: token.paddingMD, background: token.colorBgLayout }}
    >
      <Col xs={24} sm={16} md={12} lg={9} xl={7}>
      <Card>
        <Flex vertical gap="large">
          <Flex vertical gap="small">
            <Typography.Title level={4} style={{ margin: 0 }}>
              登入
            </Typography.Title>
            <Typography.Text type="secondary">
              {noIdentity
                ? '你已用 email 驗證登入。'
                : step === 'email' ? `輸入 email，我們會寄 ${OTP_LENGTH} 碼驗證碼給你。` : `驗證碼已寄出。請輸入 ${email} 收到的 ${OTP_LENGTH} 碼驗證碼。`}
            </Typography.Text>
          </Flex>

          {error && <Alert type="error" showIcon title={error} />}

          {noIdentity ? (
            <OnboardingForm />
          ) : step === 'email' ? (
            <Form
              layout="vertical"
              requiredMark={false}
              onFinish={(values: { email: string }) => void sendCode(values.email.trim())}
            >
              <Form.Item
                label="email"
                name="email"
                rules={[
                  { required: true, message: '請輸入 email' },
                  { type: 'email', message: '請輸入正確的 email' },
                ]}
              >
                <Input type="email" autoComplete="email" autoFocus placeholder="name@example.com" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block loading={loading}>
                寄送驗證碼
              </Button>
            </Form>
          ) : (
            <Flex vertical gap="middle">
              <Form layout="vertical" onFinish={(values: { code?: string }) => void verify(values.code ?? '')}>
                <Form.Item
                  label="驗證碼"
                  name="code"
                  rules={[{ len: OTP_LENGTH, message: `請輸入 ${OTP_LENGTH} 碼驗證碼` }]}
                >
                  <Input.OTP length={OTP_LENGTH} formatter={(value) => value.replace(/\D/g, '')} autoFocus onChange={(value) => value.length === OTP_LENGTH && void verify(value)} />
                </Form.Item>
                <Button type="primary" htmlType="submit" block loading={loading}>
                  登入
                </Button>
              </Form>
              <Flex justify="space-between">
                <Button type="link" disabled={loading || secondsLeft > 0} onClick={() => void sendCode(email)}>
                  {secondsLeft > 0 ? `${secondsLeft} 秒後可重寄` : '重寄驗證碼'}
                </Button>
                <Button
                  type="link"
                  onClick={() => {
                    setStep('email');
                    setError(null);
                  }}
                >
                  改用其他 email
                </Button>
              </Flex>
            </Flex>
          )}
        </Flex>
      </Card>
      </Col>
    </Row>
  );
}
