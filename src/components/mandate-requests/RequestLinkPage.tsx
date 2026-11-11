'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Descriptions, Flex, Form, Input, Skeleton, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import LogoutButton from '@/components/LogoutButton';
import { PRODUCT_NAME } from '@/components/AuthPanel';
import StatusTag from '@/components/StatusTag';
import { LINK_INVALID_MESSAGE, NOT_OWNER_ORG_MESSAGE } from '@/lib/mandate-requests/messages';
import type { LinkPageLoad } from '@/lib/mandate-requests/page-load';
import { licenseKindTitles } from '@/lib/mandate-requests/view';
import type { MandateRequestLinkView, OwnerMandateRequest } from '@/lib/types';
import OwnerRequestFlow from './OwnerRequestFlow';
import styles from './RequestLinkPage.module.css';

// 申請連結頁（MIL-206 畫面段，驗收 6、7、8）。網址是 /request/<碼>，登入前就能開，所以：
// - 不套用登入後的側欄與頁首（isAuthScreen 判斷，AppShell 直接回 children）。
// - 登入前只顯示業者的名稱、統編、已驗證的業別與申請的種類。不顯示任何物件、地址、代填的內容。
// - 所有無效的連結（不存在、過期、已送出、已收回、已被別人綁定）顯示同一段固定的文字，畫面完全相同。
// 登入沿用 email 驗證碼流程，登入後回到這一頁並自動綁定。帳號還沒有組織時，先建立屋主帳號（只填名稱），與綁定一起完成。
// 綁定後，這一頁就是屋主的確認頁（OwnerRequestFlow）。手機掃 QR code 進來，所以版面以 375px 寬為底。

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <Typography.Text strong className={styles.brand}>
          {PRODUCT_NAME}
        </Typography.Text>
        <Flex vertical gap="large">
          {children}
        </Flex>
      </div>
    </main>
  );
}

/** 所有無效連結共用的畫面。不得依原因改字或改版面。 */
function InvalidLink() {
  return (
    <Frame>
      <h1 className="type-page-title">連結無法使用</h1>
      <Alert type="warning" showIcon title={LINK_INVALID_MESSAGE} />
    </Frame>
  );
}

function PracticeCard({ view }: { view: MandateRequestLinkView }) {
  return (
    <Descriptions
      bordered
      size="small"
      column={1}
      items={[
        { key: 'name', label: '業者名稱', children: view.practice.name },
        { key: 'tax', label: '統編', children: view.practice.tax_id },
        {
          key: 'kinds',
          label: '已驗證的業別',
          children:
            view.practice.verified_kinds.length === 0 ? (
              '—'
            ) : (
              <Flex gap="var(--space-xxs)" wrap>
                {licenseKindTitles(view.practice.verified_kinds).map((title) => (
                  <Tag key={title}>{title}</Tag>
                ))}
              </Flex>
            ),
        },
        { key: 'kind', label: '申請的種類', children: view.kind_label },
      ]}
    />
  );
}

interface ApiBody {
  error?: string;
  code?: string;
  data?: { request?: OwnerMandateRequest };
}

type ClaimState =
  | { phase: 'idle' | 'claiming' }
  | { phase: 'invalid' }
  | { phase: 'error'; message: string; code?: string }
  | { phase: 'done'; request: OwnerMandateRequest };

async function postClaim(code: string, ownerName: string | null): Promise<ClaimState> {
  try {
    const res = await fetch(`/api/mandate-requests/link/${encodeURIComponent(code)}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ownerName === null ? {} : { owner_name: ownerName }),
    });
    const json = (await res.json().catch(() => ({}))) as ApiBody;
    if (res.ok && json.data?.request) return { phase: 'done', request: json.data.request };
    if (res.status === 404) return { phase: 'invalid' };
    if (res.status === 401) return { phase: 'error', message: '登入已失效，請重新登入', code: 'unauthenticated' };
    return { phase: 'error', message: json.error ?? '綁定失敗，請稍後再試', code: json.code };
  } catch {
    return { phase: 'error', message: '網路發生問題，請檢查連線後再試' };
  }
}

/** 登入後的屋主：連結有效時自動綁定，綁定後顯示確認頁。 */
function OwnerClaim({ code, view, needsName }: { code: string; view: MandateRequestLinkView; needsName: boolean }) {
  const [state, setState] = useState<ClaimState>({ phase: needsName ? 'idle' : 'claiming' });
  const [form] = Form.useForm<{ ownerName: string }>();
  const router = useRouter();

  useEffect(() => {
    if (needsName) return;
    let cancelled = false;
    void postClaim(code, null).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [code, needsName]);

  if (state.phase === 'invalid') return <InvalidLink />;

  if (state.phase === 'done') {
    const request = state.request;
    return (
      <Frame>
        <Flex vertical gap="small">
          <Flex align="center" gap="small" wrap>
            <h1 className="type-page-title">
              {request.practice.name} 的{request.kind_label}
            </h1>
            <StatusTag kind="mandateRequest" value={request.status} />
          </Flex>
          <Typography.Text type="secondary">
            統編 {request.practice.tax_id}，已驗證的業別：{licenseKindTitles(request.practice.verified_kinds).join('、') || '—'}
          </Typography.Text>
        </Flex>
        <OwnerRequestFlow request={request} groups={null} onChange={(next) => setState({ phase: 'done', request: next })} />
        {request.status !== 'pending_owner' && (
          <Flex>
            <Button size="large" onClick={() => router.push(`/requests/${request.id}`)}>
              查看申請詳情
            </Button>
          </Flex>
        )}
      </Frame>
    );
  }

  return (
    <Frame>
      <h1 className="type-page-title">
        {view.practice.name} 的{view.kind_label}
      </h1>
      <PracticeCard view={view} />
      {state.phase === 'error' && (
        <Alert
          type="error"
          showIcon
          title={state.message}
          action={state.code === 'identity_not_chosen' ? <Link href="/login">前往選擇身分</Link> : undefined}
        />
      )}
      {needsName ? (
        <Flex vertical gap="middle">
          <Typography.Paragraph>你已用 email 驗證登入。第一次使用，請先建立屋主帳號，再確認這份申請。</Typography.Paragraph>
          <Form
            form={form}
            layout="vertical"
            requiredMark={false}
            onFinish={(values) => {
              setState({ phase: 'claiming' });
              void postClaim(code, values.ownerName.trim()).then(setState);
            }}
          >
            <Form.Item label="屋主名稱" name="ownerName" rules={[{ required: true, whitespace: true, message: '請填屋主名稱' }]} extra="填你的姓名，或持有物件的名稱。">
              <Input autoComplete="name" disabled={state.phase === 'claiming'} />
            </Form.Item>
            <Button type="primary" size="large" block htmlType="submit" loading={state.phase === 'claiming'}>
              建立屋主帳號並繼續
            </Button>
          </Form>
        </Flex>
      ) : (
        state.phase === 'claiming' && <Skeleton active aria-busy="true" aria-label="正在開啟申請" />
      )}
    </Frame>
  );
}

export default function RequestLinkPage({ code, load }: { code: string; load: LinkPageLoad }) {
  if (load.kind === 'invalid') return <InvalidLink />;
  const { view } = load;

  if (load.kind === 'owner') return <OwnerClaim code={code} view={view} needsName={false} />;
  if (load.kind === 'no_identity') return <OwnerClaim code={code} view={view} needsName />;

  return (
    <Frame>
      <h1 className="type-page-title">
        {view.practice.name} 的{view.kind_label}
      </h1>
      <PracticeCard view={view} />
      {load.kind === 'not_owner' ? (
        <Flex vertical gap="middle">
          <Alert type="warning" showIcon title={NOT_OWNER_ORG_MESSAGE} />
          <Flex>
            <LogoutButton type="default" label="登出，改用屋主帳號" />
          </Flex>
        </Flex>
      ) : (
        <Flex vertical gap="middle">
          <Typography.Paragraph>業者提供了這個連結。登入後，你能確認申請內容，並選擇要交出的租賃單位。</Typography.Paragraph>
          <Button type="primary" size="large" block href={`/login?next=${encodeURIComponent(`/request/${code}`)}`}>
            登入並繼續
          </Button>
          <Typography.Text type="secondary">用 email 收驗證碼登入。第一次使用的人，登入後會建立屋主帳號。</Typography.Text>
        </Flex>
      )}
    </Frame>
  );
}
