'use client';

import { useState } from 'react';
import { Alert, App as AntApp, Button, Checkbox, Flex, Form, Input, QRCode, Radio, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import EmptyState from '@/components/page/EmptyState';
import PageHeader from '@/components/page/PageHeader';
import SettingsPage from '@/components/page/SettingsPage';
import SettingsSection from '@/components/page/SettingsSection';
import TranscriptFields, { transcriptFormData, type TranscriptFormValues } from '@/components/ownership/TranscriptFields';
import { formatTaipeiDateTime } from '@/lib/ownership/format';
import { buildAnchorPayload, type AnchorFormValues } from '@/lib/properties/anchor-form';
import { kindOptions, requestLinkUrl } from '@/lib/mandate-requests/view';
import type { MandateRequestCreated, MandateRequestKind, PropertyType } from '@/lib/types';
import DraftFields from './DraftFields';
import styles from './mandate-requests.module.css';

// 業者產生申請連結（MIL-206 畫面段，驗收 1、2、3）。一頁完成：選種類、選填代填物件資料與代傳謄本、產生連結。
// 產生後同一頁顯示連結、QR code 與複製按鈕。連結只在這一次回應出現，離開這一頁後沒有地方能再看到，要重新產生。
// 平台不寄信給屋主：沒有「寄給屋主」的功能，業者自己把連結或 QR code 交給屋主。
// 只列已驗證業別對應的種類。業別都沒驗證時不顯示表單，說明要先完成業別的核對。

interface FormValues {
  kind: MandateRequestKind;
  withDraft?: boolean;
  withTranscript?: boolean;
  name?: string;
  address?: string;
  type?: PropertyType;
  size?: number | null;
  default_rent?: number | null;
  note?: string;
  anchor?: AnchorFormValues;
  transcript?: TranscriptFormValues;
}

interface ApiError {
  error?: string;
  code?: string;
}

interface Generated {
  created: MandateRequestCreated;
  url: string;
  /** 謄本沒有送出時的原因。連結已經產生，所以只提醒，不當成失敗。 */
  transcriptError: string | null;
}

function GeneratedLinkView({ generated, onAgain }: { generated: Generated; onAgain: () => void }) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const { created, url } = generated;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      message.success('已複製連結');
    } catch {
      message.error('這個瀏覽器不能自動複製。請選取連結文字後自己複製。');
    }
  };

  return (
    <Flex vertical gap="large">
      <PageHeader title={`已產生${created.kind_label}連結`} back={{ href: '/requests', label: '返回申請列表' }} />
      <Alert
        type="warning"
        showIcon
        title="離開這一頁後不能再顯示連結，需要時重新產生"
        description="平台沒有保存連結本身，之後沒有地方能取回。請現在複製連結，或讓屋主掃描 QR code。"
      />
      {generated.transcriptError && (
        <Alert
          type="warning"
          showIcon
          title="代填的物件資料已存下，謄本沒有送出"
          description={`${generated.transcriptError}。需要代傳謄本時，請重新產生連結。`}
        />
      )}
      <SettingsSection title="給屋主的連結" description="平台不寄信給屋主。請自己把連結或 QR code 交給屋主。">
        <Flex gap="large" wrap align="flex-start">
          <QRCode value={url} type="svg" aria-label={`${created.kind_label}連結的 QR code`} />
          <Flex vertical gap="middle" className={styles.linkColumn}>
            <Input readOnly value={url} aria-label="申請連結" />
            <Flex gap="small" wrap>
              <Button type="primary" icon={<CopyOutlined />} onClick={() => void copy()}>
                複製連結
              </Button>
            </Flex>
            <Typography.Text type="secondary">連結有效到 {formatTaipeiDateTime(created.deadline)}，之後失效。</Typography.Text>
            {created.draft && <Typography.Text type="secondary">連結帶有你代填的物件資料。屋主確認前，這些資料不算登錄。</Typography.Text>}
          </Flex>
        </Flex>
      </SettingsSection>
      <Flex gap="small" wrap>
        <Button onClick={onAgain}>再產生一個</Button>
        <Button onClick={() => router.push(`/requests/${created.id}`)}>查看這份申請</Button>
      </Flex>
    </Flex>
  );
}

// antd 的 message 要在 App 底下才能用，各元件自己包一層（同 PropertyList、ContractList）
export default function RequestNewPage(props: { creatableKinds: MandateRequestKind[] }) {
  return (
    <AntApp>
      <RequestNewPageBody {...props} />
    </AntApp>
  );
}

function RequestNewPageBody({ creatableKinds }: { creatableKinds: MandateRequestKind[] }) {
  const router = useRouter();
  const [generated, setGenerated] = useState<Generated | null>(null);

  if (creatableKinds.length === 0) {
    return (
      <Flex vertical gap="large">
        <PageHeader title="產生申請連結" back={{ href: '/requests', label: '返回申請列表' }} />
        <EmptyState
          description="貴公司還沒有通過驗證的代管業或包租業，不能產生申請連結。請先完成業別的核對。"
          action={
            <Button type="primary" onClick={() => router.push('/practice')}>
              前往執業主體
            </Button>
          }
        />
      </Flex>
    );
  }

  // 表單與結果各自是一個元件：按「再產生一個」時表單重新掛載，欄位回到初始值
  return generated ? (
    <GeneratedLinkView generated={generated} onAgain={() => setGenerated(null)} />
  ) : (
    <GenerateForm creatableKinds={creatableKinds} onGenerated={setGenerated} />
  );
}

function GenerateForm({ creatableKinds, onGenerated }: { creatableKinds: MandateRequestKind[]; onGenerated: (generated: Generated) => void }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withDraft = Form.useWatch('withDraft', form);
  const withTranscript = Form.useWatch('withTranscript', form);

  const submit = async (values: FormValues) => {
    setSubmitting(true);
    setError(null);
    try {
      const draft = values.withDraft
        ? {
            name: (values.name ?? '').trim(),
            address: (values.address ?? '').trim(),
            type: values.type,
            size: values.size ?? null,
            default_rent: values.default_rent ?? null,
            note: values.note ?? '',
            equipment: [],
            anchor: buildAnchorPayload(values.anchor),
          }
        : null;
      const res = await fetch('/api/mandate-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: values.kind, draft }),
      });
      const json = (await res.json().catch(() => ({}))) as { data?: MandateRequestCreated } & ApiError;
      if (!res.ok || !json.data) {
        setError(`${json.error ?? '產生連結失敗'}。請檢查欄位後再按一次。`);
        return;
      }
      const created = json.data;

      let transcriptError: string | null = null;
      if (draft && values.withTranscript && values.transcript) {
        const body = transcriptFormData(values.transcript);
        if (!body) {
          transcriptError = '沒有選擇謄本檔案';
        } else {
          const up = await fetch(`/api/mandate-requests/${encodeURIComponent(created.id)}/transcript`, { method: 'POST', body });
          if (!up.ok) {
            const upJson = (await up.json().catch(() => ({}))) as ApiError;
            transcriptError = upJson.error ?? '謄本上傳失敗';
          }
        }
      }
      onGenerated({ created, url: requestLinkUrl(window.location.origin, created.link_path), transcriptError });
    } catch {
      setError('網路發生問題。請檢查連線後再按一次。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Form<FormValues>
      form={form}
      layout="vertical"
      requiredMark={false}
      disabled={submitting}
      initialValues={{ kind: creatableKinds[0], type: '整層住家', withDraft: false, withTranscript: false }}
      onFinish={(values) => void submit(values)}
      onFinishFailed={() => {
        void message.error('欄位有誤，請修正後再按一次');
      }}
    >
      <SettingsPage
        header={{ title: '產生申請連結', back: { href: '/requests', label: '返回申請列表' } }}
        notices={error ? <Alert type="error" showIcon title={error} /> : undefined}
      >
        <SettingsSection title="申請的種類" description="只列貴公司已通過驗證的業別對應的種類。連結 7 天後失效。">
          <Form.Item name="kind" noStyle>
            <Radio.Group options={kindOptions(creatableKinds)} />
          </Form.Item>
        </SettingsSection>

        <SettingsSection
          title="代填物件資料（選填）"
          description="先替屋主填好房子的資料。屋主確認前，這些資料不算登錄，不佔建號，別人查不到。7 天後連同連結一起失效。"
        >
          <Form.Item name="withDraft" valuePropName="checked" noStyle>
            <Checkbox>替屋主代填物件資料</Checkbox>
          </Form.Item>
          {withDraft && <DraftFields form={form} />}
        </SettingsSection>

        {withDraft && (
          <SettingsSection
            title="代傳謄本（選填）"
            description="業者代傳謄本不代表屋主同意個資告知。屋主確認代填資料並同意後，平台才把謄本轉成屋主的謄本送核對。"
          >
            <Form.Item name="withTranscript" valuePropName="checked" noStyle>
              <Checkbox>代傳這個物件的謄本</Checkbox>
            </Form.Item>
            {withTranscript && <TranscriptFields form={form} prefix={['transcript']} />}
          </SettingsSection>
        )}

        <Flex>
          <Button type="primary" htmlType="submit" loading={submitting}>
            產生申請連結
          </Button>
        </Flex>
      </SettingsPage>
    </Form>
  );
}
