'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Checkbox, Descriptions, Flex, Typography } from 'antd';
import Link from 'next/link';
import EmptyState from '@/components/page/EmptyState';
import SettingsSection from '@/components/page/SettingsSection';
import { formatTaipeiDateTime } from '@/lib/ownership/format';
import { draftBuildingText, licenseKindTitles, ownerCanWithdraw, unitOptions, type UnitOption } from '@/lib/mandate-requests/view';
import type { MandateRequestDraft, OwnerMandateRequest, PropertyGroup } from '@/lib/types';
import styles from './mandate-requests.module.css';

// 屋主確認與送出申請（MIL-206 畫面段，驗收 8、9、10、11、12、14）。
// 兩個地方用它：登入前的連結頁登入並綁定之後（/request/<碼>，沒有側欄，手機掃 QR code 進來），
// 與後台的申請詳情（/requests/<id>）。兩處顯示同一份內容。
// 流程：確認業者代填的資料（有的話）、勾選要交出的租賃單位（多選）、送出。送出後、業者接受前，能收回。
// 狀態一律用 API 回傳的 status，這裡不算日期。租賃單位被佔用時，只顯示伺服端的固定訊息，不提任何業者。

export interface OwnerRequestFlowProps {
  request: OwnerMandateRequest;
  /** 屋主已登錄的租賃單位。null 表示還沒載入，元件自己讀 GET /api/properties?group=object。 */
  groups: PropertyGroup[] | null;
  /** 申請的內容改變後呼叫（確認代填資料、送出、收回），父層更新畫面。 */
  onChange: (request: OwnerMandateRequest) => void;
  /** 送出後的摘要要不要列出業者的名稱、統編與業別。詳情頁的側欄已經列了，傳 false。 */
  showPractice?: boolean;
}

interface ApiError {
  error?: string;
  code?: string;
}

type TranscriptOutcome = 'forwarded' | 'not_forwarded' | 'declined' | 'none';

interface ConfirmedInfo {
  existing: boolean;
  transcript: TranscriptOutcome;
}

const TRANSCRIPT_OUTCOME_TEXT: Record<TranscriptOutcome, string | null> = {
  forwarded: '業者代傳的謄本已轉成你的謄本，送平台核對。核對完成後，會用站內通知告訴你。',
  not_forwarded: '業者代傳的謄本沒有轉入。需要核對時，請自己上傳謄本。',
  declined: '你選了不同意，謄本不會轉給平台。需要核對時，請自己上傳謄本。',
  none: null,
};

/** 屋主已登錄的租賃單位。讀不到時回 null，選單維持目前的內容，使用者重新整理頁面即可。 */
async function fetchGroups(): Promise<PropertyGroup[] | null> {
  try {
    const res = await fetch('/api/properties?group=object');
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: PropertyGroup[] };
    return json.data ?? [];
  } catch {
    return null;
  }
}

function draftItems(draft: MandateRequestDraft) {
  const building = draftBuildingText(draft);
  const items: Array<{ key: string; label: string; children: string }> = [
    { key: 'name', label: '物件名稱', children: draft.name },
    { key: 'address', label: '地址', children: draft.address },
  ];
  if (building) items.push({ key: 'building', label: '建號', children: building });
  if (draft.type) items.push({ key: 'type', label: '型態', children: draft.type });
  if (draft.size != null) items.push({ key: 'size', label: '坪數', children: `${draft.size} 坪` });
  if (draft.default_rent != null) items.push({ key: 'rent', label: '預設租金', children: `${draft.default_rent.toLocaleString('zh-TW')} 元/月` });
  if (draft.note) items.push({ key: 'note', label: '備註', children: draft.note });
  return items;
}

function UnitChoice({ option, checked, disabled, onChange }: { option: UnitOption; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <Checkbox className={checked ? styles.unitSelected : styles.unit} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)}>
      <Flex vertical gap="var(--space-xxs)">
        <Typography.Text strong>{option.name}</Typography.Text>
        <Typography.Text type="secondary">
          {option.kindText}，{option.address}
        </Typography.Text>
        {option.displayCode && <Typography.Text type="secondary" className="type-caption">顯示編碼 {option.displayCode}</Typography.Text>}
      </Flex>
    </Checkbox>
  );
}

export default function OwnerRequestFlow({ request, groups, onChange, showPractice = true }: OwnerRequestFlowProps) {
  const { message, modal } = AntApp.useApp();
  const [fetchedGroups, setFetchedGroups] = useState<PropertyGroup[] | null>(null);
  const [picked, setPicked] = useState<string[]>(() => (request.confirmed_unit_id ? [request.confirmed_unit_id] : []));
  const [confirming, setConfirming] = useState<'agree' | 'decline' | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmedInfo | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);

  const loadGroups = useCallback(async () => {
    const next = await fetchGroups();
    if (next) setFetchedGroups(next);
  }, []);

  // 父層沒給租賃單位時（登入前連結頁綁定之後），自己讀一次
  useEffect(() => {
    if (groups !== null) return;
    let cancelled = false;
    void fetchGroups().then((next) => {
      if (!cancelled && next) setFetchedGroups(next);
    });
    return () => {
      cancelled = true;
    };
  }, [groups]);

  const options = useMemo(() => unitOptions(fetchedGroups ?? groups ?? []), [fetchedGroups, groups]);
  const groupsLoading = groups === null && fetchedGroups === null;
  const pending = request.status === 'pending_owner';
  const hasDraft = request.draft !== null;
  const draftConfirmed = request.confirmed_unit_id !== null || confirmed !== null;

  const refreshRequest = async () => {
    const res = await fetch(`/api/mandate-requests/${encodeURIComponent(request.id)}`);
    if (!res.ok) return;
    const json = (await res.json()) as { data?: OwnerMandateRequest };
    if (json.data) onChange(json.data);
  };

  const confirmDraft = async (consent: 'agree' | 'decline') => {
    setConfirming(consent);
    setConfirmError(null);
    try {
      const res = await fetch(`/api/mandate-requests/${encodeURIComponent(request.id)}/confirm-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        data?: { rental_unit_id?: string; existing?: boolean; already_confirmed?: boolean; transcript?: TranscriptOutcome };
      } & ApiError;
      if (!res.ok || !json.data) {
        setConfirmError(`${json.error ?? '確認失敗'}。請稍後再按一次。`);
        return;
      }
      const unitId = json.data.rental_unit_id;
      if (unitId) setPicked((current) => (current.includes(unitId) ? current : [...current, unitId]));
      setConfirmed({ existing: json.data.existing === true, transcript: json.data.transcript ?? 'none' });
      await Promise.all([loadGroups(), refreshRequest()]);
    } catch {
      setConfirmError('網路發生問題。請檢查連線後再按一次。');
    } finally {
      setConfirming(null);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/mandate-requests/${encodeURIComponent(request.id)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unit_ids: picked }),
      });
      const json = (await res.json().catch(() => ({}))) as { data?: OwnerMandateRequest } & ApiError;
      if (!res.ok || !json.data) {
        setSubmitError(`${json.error ?? '送出失敗'}。`);
        return;
      }
      message.success('申請已送出');
      onChange(json.data);
    } catch {
      setSubmitError('網路發生問題。請檢查連線後再按一次。');
    } finally {
      setSubmitting(false);
    }
  };

  const withdraw = async () => {
    setWithdrawing(true);
    try {
      const res = await fetch(`/api/mandate-requests/${encodeURIComponent(request.id)}/withdraw`, { method: 'POST' });
      const json = (await res.json().catch(() => ({}))) as { data?: OwnerMandateRequest } & ApiError;
      if (!res.ok || !json.data) {
        message.error(`${json.error ?? '收回失敗'}。`);
        return;
      }
      message.success('申請已收回');
      onChange(json.data);
    } catch {
      message.error('網路發生問題。請檢查連線後再按一次。');
    } finally {
      setWithdrawing(false);
    }
  };

  const askWithdraw = () => {
    modal.confirm({
      title: '收回這份申請？',
      content: '收回後，業者會收到通知。這份申請不能恢復，需要時請向業者索取新的連結。',
      okText: '收回申請',
      okButtonProps: { danger: true },
      cancelText: '先不要',
      onOk: () => withdraw(),
    });
  };

  if (!pending) {
    const submittedUnits = options.filter((o) => request.unit_ids.includes(o.unitId));
    return (
      <Flex vertical gap="large">
        <SettingsSection title="申請內容">
          <Descriptions
            size="small"
            column={1}
            items={[
              ...(showPractice
                ? [
                    { key: 'practice', label: '業者', children: request.practice.name },
                    { key: 'tax', label: '統編', children: request.practice.tax_id },
                    { key: 'kinds', label: '已驗證的業別', children: licenseKindTitles(request.practice.verified_kinds).join('、') || '—' },
                  ]
                : []),
              { key: 'kind', label: '申請的種類', children: request.kind_label },
              { key: 'submitted', label: '送出時間', children: formatTaipeiDateTime(request.submitted_at) },
              ...(request.withdrawn_at ? [{ key: 'withdrawn', label: '收回時間', children: formatTaipeiDateTime(request.withdrawn_at) }] : []),
              ...(request.deadline ? [{ key: 'deadline', label: '期限', children: formatTaipeiDateTime(request.deadline) }] : []),
              {
                key: 'units',
                label: '租賃單位',
                children:
                  submittedUnits.length > 0 ? (
                    <Flex vertical gap="var(--space-xxs)">
                      {submittedUnits.map((o) => (
                        <span key={o.unitId}>
                          {o.name}（{o.kindText}）
                        </span>
                      ))}
                    </Flex>
                  ) : (
                    `${request.unit_ids.length} 個`
                  ),
              },
            ]}
          />
        </SettingsSection>
        {ownerCanWithdraw(request) && (
          <Flex vertical gap="small">
            <Typography.Text type="secondary">業者接受前，你能收回申請。</Typography.Text>
            <Flex>
              <Button danger size="large" loading={withdrawing} onClick={askWithdraw}>
                收回申請
              </Button>
            </Flex>
          </Flex>
        )}
      </Flex>
    );
  }

  const draft = request.draft;
  const notice = request.consent_notice;
  const draftSection =
    hasDraft && draft ? (
      <SettingsSection title="業者代填的物件資料" description="請確認內容。確認後，這個物件登錄在你的帳號，成為你自己的物件。確認前，這些資料不算登錄。">
        <Descriptions size="small" column={1} items={draftItems(draft)} />
        {draftConfirmed ? (
          <Alert
            type="success"
            showIcon
            title="已確認，這個物件已登錄在你的帳號"
            description={
              <Flex vertical gap="var(--space-xxs)">
                {confirmed?.existing && <span>你已登錄過同一個建號，已使用既有的物件。</span>}
                {confirmed && TRANSCRIPT_OUTCOME_TEXT[confirmed.transcript] && <span>{TRANSCRIPT_OUTCOME_TEXT[confirmed.transcript]}</span>}
                <span>這個租賃單位已在下方勾選。</span>
              </Flex>
            }
          />
        ) : (
          <Flex vertical gap="middle">
            {notice && (
              <Flex vertical gap="small">
                <h3 className="type-section-title">{notice.title}</h3>
                <Typography.Paragraph className={styles.noticeText}>{notice.text}</Typography.Paragraph>
                <Typography.Text type="secondary">
                  {request.has_transcript
                    ? '業者代傳了這個物件的謄本。你同意後，平台才把謄本轉成你的謄本送核對。你不同意時，仍能確認資料與送出申請，核對時要自己上傳謄本。'
                    : '業者沒有代傳謄本。你仍能先決定是否同意，之後上傳謄本時會用到。你不同意時，仍能確認資料與送出申請。'}
                </Typography.Text>
              </Flex>
            )}
            {confirmError && <Alert type="error" showIcon title={confirmError} />}
            <Flex gap="small" wrap>
              <Button size="large" loading={confirming === 'agree'} disabled={confirming !== null} onClick={() => void confirmDraft('agree')}>
                同意並確認資料
              </Button>
              <Button size="large" loading={confirming === 'decline'} disabled={confirming !== null} onClick={() => void confirmDraft('decline')}>
                不同意，仍確認資料
              </Button>
            </Flex>
          </Flex>
        )}
      </SettingsSection>
    ) : null;

  return (
    <Flex vertical gap="large">
      {draftSection}
      <SettingsSection title="選擇要交出的租賃單位" description="選你已登錄的租賃單位，一次能選多個。送出前，業者看不到你選的租賃單位。">
        {options.length === 0 ? (
          <EmptyState
            description={
              groupsLoading
                ? '載入中'
                : hasDraft && !draftConfirmed
                  ? '你還沒有登錄的租賃單位。確認上面的代填資料後，物件會出現在這裡。'
                  : '你還沒有登錄的租賃單位。請先登錄物件，再回到這份申請。'
            }
            action={
              !groupsLoading && !(hasDraft && !draftConfirmed) ? (
                <Link href="/properties">
                  <Button>前往物件列表</Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <Flex vertical gap="small" role="group" aria-label="租賃單位">
            {options.map((option) => (
              <UnitChoice
                key={option.unitId}
                option={option}
                checked={picked.includes(option.unitId)}
                disabled={submitting}
                onChange={(checked) => setPicked((current) => (checked ? [...current, option.unitId] : current.filter((id) => id !== option.unitId)))}
              />
            ))}
          </Flex>
        )}
      </SettingsSection>
      <Flex vertical gap="small">
        {hasDraft && !draftConfirmed && <Alert type="warning" showIcon title="你還沒確認業者代填的資料。直接送出時，代填的資料會被刪除，不會登錄。" />}
        {submitError && <Alert type="error" showIcon title={submitError} />}
        <Typography.Text type="secondary">已選 {picked.length} 個租賃單位</Typography.Text>
        <Flex>
          <Button type="primary" size="large" className={styles.submitButton} loading={submitting} disabled={picked.length === 0} onClick={() => void submit()}>
            送出申請
          </Button>
        </Flex>
      </Flex>
    </Flex>
  );
}
