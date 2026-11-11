'use client';

import { useState } from 'react';
import { Alert, App as AntApp, Button, Descriptions, Flex, Modal, Radio, Typography } from 'antd';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import DetailPage from '@/components/page/DetailPage';
import NextStep from '@/components/page/NextStep';
import SettingsSection from '@/components/page/SettingsSection';
import StatusTag from '@/components/StatusTag';
import { formatTaipeiDateTime } from '@/lib/ownership/format';
import {
  canEndRequest,
  DECLINE_CONFIRM_TEXT,
  decisionErrorReloads,
  decisionErrorText,
  draftBuildingNo,
  NO_MANAGER_HINT,
  ONLY_ADMIN_END_TEXT,
  ONLY_ADMIN_RESPOND_TEXT,
  practiceCanRespond,
  practiceClosedByText,
  practiceDeadlineText,
  practiceMayShowUnits,
  practiceNextStep,
  PRACTICE_END_CONFIRM_TEXT,
} from '@/lib/mandate-requests/view';
import type { MandateManagerCandidate, PracticeMandateRequest } from '@/lib/types';
import styles from './mandate-requests.module.css';

// 業者的申請詳情（MIL-206 畫面段，驗收 13；MIL-210 前半畫面段）。只顯示種類、狀態、建立與失效的時間、代填的摘要。
// 屋主送出後，多顯示租賃單位的數量。接受之後，不顯示任何物件的資料，也不放「查看物件」「擬約」這類還不能用的入口。
// 不得顯示或暗示連結有沒有被打開：資料段的回應在「沒人打開」「有人打開」「已綁定但沒送出」三種情況逐位元相同，
// 這裡也沒有任何依這些情況而變的欄位或文字。
// 待業者接受時，組織管理員在「下一步」看到「接受」與「不接受」。接受要先從候選名單選一位租賃住宅管理人員。
// 已接受時，組織管理員看到「結束申請」。其他角色只看到說明。
// 給 MIL-212：已接受的詳情要加「物件」與「擬約」的位置，放在 nextStep 的 children 之後、aside 的「申請資訊」之前。
// 狀態一律用 API 回傳的 status，這裡不算日期。

export interface PracticeRequestDetailProps {
  request: PracticeMandateRequest;
  /** 目前身分是組織管理員。 */
  isAdmin: boolean;
  /** 接受時能指派的管理人員。 */
  candidates: MandateManagerCandidate[];
  /** 已接受時指派的管理人員姓名。 */
  managerName: string | null;
}

interface ApiResult {
  data?: PracticeMandateRequest;
  error?: string;
  code?: string;
}

// antd 的 message 與 modal 要在 App 底下才能用，AppConfigProvider 沒有包，各元件自己包一層（同 OwnerRequestFlow）
export default function PracticeRequestDetail(props: PracticeRequestDetailProps) {
  return (
    <AntApp>
      <PracticeRequestDetailBody {...props} />
    </AntApp>
  );
}

function PracticeRequestDetailBody({ request: initial, isAdmin, candidates, managerName }: PracticeRequestDetailProps) {
  const { message, modal } = AntApp.useApp();
  const router = useRouter();
  const [request, setRequest] = useState(initial);
  const [lastInitial, setLastInitial] = useState(initial);
  if (lastInitial !== initial) {
    setLastInitial(initial);
    setRequest(initial);
  }
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState<'accept' | 'decline' | 'end' | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const step = practiceNextStep(request);
  const draft = request.draft;
  const building = draftBuildingNo(draft);
  const mayShowUnits = practiceMayShowUnits(request);
  const deadlineText = practiceDeadlineText(request);
  const closedByText = practiceClosedByText(request);
  const canRespond = practiceCanRespond(request);
  const canEnd = canEndRequest(request);
  const noManager = candidates.length === 0;

  // 動作成功：更新畫面並請 server component 重新載入。失敗：顯示固定訊息，狀態已改變時重新載入。
  const call = async (action: 'accept' | 'decline' | 'end', body?: unknown): Promise<{ ok: boolean; error?: string }> => {
    setBusy(action);
    try {
      const res = await fetch(`/api/mandate-requests/${encodeURIComponent(request.id)}/${action}`, {
        method: 'POST',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const json = (await res.json().catch(() => ({}))) as ApiResult;
      if (!res.ok || !json.data) {
        if (decisionErrorReloads(json.code)) router.refresh();
        return { ok: false, error: decisionErrorText(json.code, json.error, '操作失敗，請稍後再試') };
      }
      setRequest(json.data);
      router.refresh();
      return { ok: true };
    } catch (error) {
      console.error('申請操作失敗', error);
      return { ok: false, error: '網路發生問題。請檢查連線後再按一次。' };
    } finally {
      setBusy(null);
    }
  };

  const submitAccept = async () => {
    if (!picked) return;
    setAcceptError(null);
    const result = await call('accept', { manager_employment_id: picked });
    if (result.ok) {
      setAcceptOpen(false);
      message.success('申請已接受');
    } else {
      setAcceptError(result.error ?? null);
    }
  };

  const askDecline = () => {
    modal.confirm({
      title: '不接受這份申請？',
      content: DECLINE_CONFIRM_TEXT,
      okText: '不接受',
      okButtonProps: { danger: true },
      cancelText: '先不要',
      onOk: async () => {
        const result = await call('decline');
        if (result.ok) message.success('已回覆：未接受');
        else message.error(result.error);
      },
    });
  };

  const askEnd = () => {
    modal.confirm({
      title: '結束這份申請？',
      content: PRACTICE_END_CONFIRM_TEXT,
      okText: '結束申請',
      okButtonProps: { danger: true },
      cancelText: '先不要',
      onOk: async () => {
        const result = await call('end');
        if (result.ok) message.success('申請已結束');
        else message.error(result.error);
      },
    });
  };

  const actions =
    isAdmin && canRespond ? (
      <>
        <Button danger disabled={busy !== null} onClick={askDecline}>
          不接受
        </Button>
        <Button
          type="primary"
          disabled={noManager || busy !== null}
          onClick={() => {
            setPicked(candidates.length === 1 ? candidates[0].employment_id : null);
            setAcceptError(null);
            setAcceptOpen(true);
          }}
        >
          接受
        </Button>
      </>
    ) : isAdmin && canEnd ? (
      <Button danger disabled={busy !== null} onClick={askEnd}>
        結束申請
      </Button>
    ) : undefined;

  const nextStepNote = (() => {
    if (!isAdmin && canRespond) return <Typography.Text type="secondary">{ONLY_ADMIN_RESPOND_TEXT}</Typography.Text>;
    if (!isAdmin && canEnd) return <Typography.Text type="secondary">{ONLY_ADMIN_END_TEXT}</Typography.Text>;
    if (isAdmin && canRespond && noManager) {
      return (
        <Alert
          type="warning"
          showIcon
          title={NO_MANAGER_HINT}
          action={
            <Link href="/practice">
              <Button size="small">前往執業主體</Button>
            </Link>
          }
        />
      );
    }
    return undefined;
  })();

  return (
    <>
      <DetailPage
        header={{
          title: request.kind_label,
          tag: <StatusTag kind="mandateRequest" value={request.status} />,
          back: { href: '/requests', label: '返回申請列表' },
        }}
        nextStep={
          <NextStep headline={step.headline} owner={step.owner} detail={step.detail} tone={step.tone} actions={actions}>
            {nextStepNote}
          </NextStep>
        }
        aside={
          <SettingsSection title="申請資訊">
            <Descriptions
              size="small"
              column={1}
              items={[
                { key: 'kind', label: '申請的種類', children: request.kind_label },
                { key: 'created', label: '建立時間', children: formatTaipeiDateTime(request.created_at) },
                ...(deadlineText
                  ? [
                      {
                        key: 'deadline',
                        label: request.status === 'pending_practice' ? '業者回覆的期限' : request.status === 'accepted' ? '送出合約的期限' : '連結失效時間',
                        children: deadlineText,
                      },
                    ]
                  : []),
                ...(request.submitted_at ? [{ key: 'submitted', label: '屋主送出時間', children: formatTaipeiDateTime(request.submitted_at) }] : []),
                ...(request.withdrawn_at ? [{ key: 'withdrawn', label: '屋主收回時間', children: formatTaipeiDateTime(request.withdrawn_at) }] : []),
                ...(request.accepted_at ? [{ key: 'accepted', label: '接受時間', children: formatTaipeiDateTime(request.accepted_at) }] : []),
                ...(request.accepted_at ? [{ key: 'manager', label: '指派的管理人員', children: managerName ?? '—' }] : []),
                ...(request.status === 'declined' && request.closed_at ? [{ key: 'declined', label: '未接受時間', children: formatTaipeiDateTime(request.closed_at) }] : []),
                ...(request.status === 'ended' && request.closed_at
                  ? [{ key: 'ended', label: '結束時間', children: closedByText ? `${formatTaipeiDateTime(request.closed_at)}，${closedByText}` : formatTaipeiDateTime(request.closed_at) }]
                  : []),
                ...(request.unit_count !== null && mayShowUnits ? [{ key: 'units', label: '租賃單位', children: `${request.unit_count} 個` }] : []),
              ]}
            />
          </SettingsSection>
        }
      >
        {mayShowUnits && (
          <SettingsSection
            title="代填的物件資料"
            description="這是你替屋主填的資料。屋主確認前，不算登錄，不佔建號。連結失效、屋主送出或收回後，資料會刪除。"
          >
            {draft ? (
              <Descriptions
                size="small"
                column={1}
                items={[
                  { key: 'name', label: '物件名稱', children: draft.name },
                  { key: 'address', label: '地址', children: draft.address },
                  ...(building ? [{ key: 'building', label: '建號', children: building }] : []),
                  { key: 'transcript', label: '代傳的謄本', children: request.transcript_file_name ?? '沒有代傳' },
                ]}
              />
            ) : (
              <span>{request.status === 'pending_owner' ? '沒有代填資料。屋主會從自己已登錄的租賃單位選。' : '沒有代填資料，或資料已刪除。'}</span>
            )}
          </SettingsSection>
        )}
      </DetailPage>
      <Modal
        title="接受申請並指派管理人員"
        open={acceptOpen}
        onCancel={() => busy === null && setAcceptOpen(false)}
        okText="接受申請"
        cancelText="先不要"
        okButtonProps={{ disabled: picked === null }}
        confirmLoading={busy === 'accept'}
        onOk={() => void submitAccept()}
        destroyOnHidden
      >
        <Flex vertical gap="middle">
          <Typography.Text type="secondary">接受時必須指派一位租賃住宅管理人員。這個人由你的組織負責這份申請。</Typography.Text>
          <Radio.Group
            value={picked}
            onChange={(e) => setPicked(e.target.value as string)}
            aria-label="管理人員"
            disabled={busy === 'accept'}
            className={styles.managerGroup}
          >
            <Flex vertical gap="small">
              {candidates.map((candidate) => (
                <Radio key={candidate.employment_id} value={candidate.employment_id} className={styles.managerOption}>
                  {candidate.display_name}
                </Radio>
              ))}
            </Flex>
          </Radio.Group>
          {acceptError && <Alert type="error" showIcon title={acceptError} />}
        </Flex>
      </Modal>
    </>
  );
}
