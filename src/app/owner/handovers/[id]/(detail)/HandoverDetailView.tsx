'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Descriptions,
  Flex,
  Form,
  Input,
  Popconfirm,
  Radio,
  Select,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import DetailPage from '@/components/page/DetailPage';
import NextStep from '@/components/page/NextStep';
import StatusTag from '@/components/StatusTag';
import { PRACTICE_ENTITY_STATUS_LABELS, RECEIVER_MANDATE_LABELS, targetLabel } from '@/lib/handover/labels';
import { handoverNextStep } from '@/lib/handover/next-step';
import { checkHandoverPreconditions, type HandoverTargetFacts } from '@/lib/handover/preconditions';
import type { ConfirmTargetInput, HandoverDetail } from '@/lib/handover/service';
import type { HandoverManualFields } from '@/lib/handover/snapshot';
import { cancelHandoverAction, confirmHandoverAction, saveManualFieldsAction } from '../../actions';
import { ErrorList, ExportPackageButton, SidesStatus, SnapshotContent } from '../../HandoverParts';
import styles from '../../handovers.module.css';

// 屋主端移交詳情（MIL-97、MIL-182）：詳情頁版型。頂端寫出移交進度與下一步，左側是移交包與表單，右側是移交屬性。

function CancelButton({ id, onDone }: { id: string; onDone: (errors: string[]) => void }) {
  const [pending, startTransition] = useTransition();
  return (
    // TODO(MIL-108)：依 authorize() 的結果決定是否顯示「取消移交」
    <Popconfirm
      title="取消這個移交？"
      description="取消後要重新發起才能移交這個租賃單位。"
      okText="取消移交"
      okButtonProps={{ danger: true }}
      cancelText="返回"
      onConfirm={() =>
        startTransition(async () => {
          const result = await cancelHandoverAction(id);
          onDone(result.ok ? [] : result.errors);
        })
      }
    >
      <Button danger loading={pending}>
        取消移交
      </Button>
    </Popconfirm>
  );
}

type TargetKind = 'mandatary' | 'self_managed';

function DraftForm({
  detail,
  today,
  setErrors,
  onReasons,
}: {
  detail: HandoverDetail;
  today: string;
  setErrors: (errors: string[]) => void;
  onReasons: (messages: string[]) => void;
}) {
  const { message } = AntApp.useApp();
  const { record, snapshot } = detail;
  const [manual, setManual] = useState<HandoverManualFields>(record.manual);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [kind, setKind] = useState<TargetKind | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [effectiveDate, setEffectiveDate] = useState<Dayjs | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [evidenceNote, setEvidenceNote] = useState('');
  const [saving, startSave] = useTransition();
  const [confirming, startConfirm] = useTransition();

  const manualDirty =
    manual.keyHandover !== record.manual.keyHandover ||
    manual.accessCardHandover !== record.manual.accessCardHandover ||
    manual.committeeContact !== record.manual.committeeContact;

  const candidate = detail.candidates.find((c) => c.orgId === orgId) ?? null;
  const account = detail.paymentAccounts.find((a) => a.id === accountId) ?? null;
  const holderChanges =
    kind === 'self_managed' &&
    account !== null &&
    detail.currentAccountHolder !== null &&
    detail.currentAccountHolder !== account.holderName;

  // 擋下原因隨選擇即時更新，和確認時伺服器端用同一個純函式
  const reasons = useMemo(() => {
    let target: HandoverTargetFacts | null = null;
    if (kind === 'self_managed') target = { kind: 'self_managed' };
    if (kind === 'mandatary' && candidate) {
      target = { kind: 'mandatary', mandate: candidate.mandate, practiceEntityStatus: candidate.status };
    }
    return checkHandoverPreconditions({
      hasActiveSigningTask: detail.hasActiveSigningTask,
      target,
      effectiveDate: kind === 'self_managed' && effectiveDate ? effectiveDate.format('YYYY-MM-DD') : null,
      today,
    });
  }, [kind, candidate, effectiveDate, detail.hasActiveSigningTask, today]);

  // 擋下原因顯示在頁面頂端的提醒區，這裡把訊息交給父層
  const reasonMessages = useMemo(() => reasons.map((r) => r.message), [reasons]);
  useEffect(() => onReasons(reasonMessages), [reasonMessages, onReasons]);

  const allAcknowledged = snapshot.missing.every((m) => acknowledged.includes(m.key));
  const targetReady =
    (kind === 'mandatary' && candidate !== null) ||
    (kind === 'self_managed' && effectiveDate !== null && account !== null && (!holderChanges || evidenceNote.trim() !== ''));
  const canConfirm = allAcknowledged && targetReady && reasons.length === 0 && !manualDirty;

  const save = () =>
    startSave(async () => {
      const result = await saveManualFieldsAction(record.id, manual);
      if (result.ok) message.success('已儲存手填欄位');
      else setErrors(result.errors);
    });

  const confirm = () => {
    let target: ConfirmTargetInput;
    if (kind === 'mandatary' && orgId) target = { kind: 'mandatary', orgId };
    else if (kind === 'self_managed' && effectiveDate && accountId) {
      target = {
        kind: 'self_managed',
        paymentAccountId: accountId,
        effectiveDate: effectiveDate.format('YYYY-MM-DD'),
        evidenceNote,
      };
    } else return;
    startConfirm(async () => {
      const result = await confirmHandoverAction(record.id, { acknowledgedMissing: acknowledged, target });
      if (result.ok) {
        setErrors([]);
        message.success(kind === 'self_managed' ? '已確認改為自管，等待生效日' : '已確認，等待新受託人接手');
      } else {
        setErrors(result.errors);
      }
    });
  };

  return (
    <>
      <Card size="small" title="移交包內容">
        <SnapshotContent snapshot={snapshot} />
      </Card>

      <Card size="small" title="實物與行政（手填）">
        <Form layout="vertical" component="div" className={styles.formBody}>
          <Form.Item label="鑰匙交付紀錄" htmlFor="manual-keys">
            <Input
              id="manual-keys"
              value={manual.keyHandover}
              placeholder="例：大門鑰匙 2 把，已交付新受託人"
              onChange={(e) => setManual({ ...manual, keyHandover: e.target.value })}
            />
          </Form.Item>
          <Form.Item label="門禁卡交付紀錄" htmlFor="manual-cards">
            <Input
              id="manual-cards"
              value={manual.accessCardHandover}
              placeholder="例：門禁感應扣 2 個"
              onChange={(e) => setManual({ ...manual, accessCardHandover: e.target.value })}
            />
          </Form.Item>
          <Form.Item label="管委會窗口" htmlFor="manual-committee">
            <Input
              id="manual-committee"
              value={manual.committeeContact}
              placeholder="例：管委會總幹事與聯絡時間"
              onChange={(e) => setManual({ ...manual, committeeContact: e.target.value })}
            />
          </Form.Item>
          <Button onClick={save} loading={saving} disabled={!manualDirty}>
            儲存手填欄位
          </Button>
        </Form>
      </Card>

      <Card size="small" title={`缺項（${snapshot.missing.length}）`}>
        {snapshot.missing.length === 0 ? (
          <Typography.Text type="secondary">沒有缺項。</Typography.Text>
        ) : (
          <Flex vertical gap="middle">
            <Typography.Text type="secondary">
              缺項不會中斷移交，但每一項都要勾選知悉才能確認。缺項會列在移交包的索引。
            </Typography.Text>
            <Checkbox.Group value={acknowledged} onChange={(values) => setAcknowledged(values as string[])}>
              <Flex vertical gap="small">
                {snapshot.missing.map((m) => (
                  <Checkbox key={m.key} value={m.key}>
                    我知道「{m.category}：{m.label}」沒有資料
                  </Checkbox>
                ))}
              </Flex>
            </Checkbox.Group>
          </Flex>
        )}
      </Card>

      <Card size="small" title="誰接手">
        <Flex vertical gap="middle">
          <Radio.Group value={kind} onChange={(e) => setKind(e.target.value)}>
            <Flex vertical gap="small">
              <Radio value="mandatary">交給新受託人</Radio>
              <Radio value="self_managed">改為自管</Radio>
            </Flex>
          </Radio.Group>

          {kind === 'mandatary' && (
            <Form layout="vertical" component="div" className={styles.formBody}>
              <Form.Item
                label="新受託人"
                htmlFor="receiver"
                extra="生效日與收款帳戶由新受託人在確認接手時指定。"
                className={styles.flush}
              >
                <Select
                  id="receiver"
                  value={orgId}
                  placeholder="選擇新受託人"
                  onChange={setOrgId}
                  options={detail.candidates.map((c) => ({
                    value: c.orgId,
                    label: `${c.name}（${PRACTICE_ENTITY_STATUS_LABELS[c.status]}、${RECEIVER_MANDATE_LABELS[c.mandate]}）`,
                  }))}
                />
              </Form.Item>
            </Form>
          )}

          {kind === 'self_managed' && (
            <Form layout="vertical" component="div" className={styles.formBody}>
              <Form.Item label="生效日" htmlFor="effective-date">
                <DatePicker
                  id="effective-date"
                  value={effectiveDate}
                  onChange={setEffectiveDate}
                  disabledDate={(d) => d.isBefore(dayjs(today), 'day')}
                  className={styles.dateInput}
                />
              </Form.Item>
              <Form.Item label="押金與預收租金的收款帳戶" htmlFor="payment-account">
                <Select
                  id="payment-account"
                  value={accountId}
                  placeholder="選擇收款帳戶"
                  onChange={setAccountId}
                  options={detail.paymentAccounts.map((a) => ({ value: a.id, label: `${a.label}（${a.holderName}）` }))}
                />
              </Form.Item>
              {holderChanges && account && (
                <Form.Item
                  label="收款帳戶變更說明"
                  htmlFor="evidence-note"
                  extra={`收款帳戶持有人會從「${detail.currentAccountHolder}」改為「${account.holderName}」。請說明押金與預收租金如何轉入。`}
                  className={styles.flush}
                >
                  <Input.TextArea
                    id="evidence-note"
                    value={evidenceNote}
                    autoSize={{ minRows: 2 }}
                    onChange={(e) => setEvidenceNote(e.target.value)}
                  />
                </Form.Item>
              )}
            </Form>
          )}
        </Flex>
      </Card>

      <Flex vertical gap="small">
        {/* TODO(MIL-108)：依 authorize() 的結果決定是否顯示「確認移交」 */}
        <Flex>
          <Button type="primary" disabled={!canConfirm} loading={confirming} onClick={confirm}>
            確認移交
          </Button>
        </Flex>
        {manualDirty && <Typography.Text type="secondary">手填欄位有變更，先儲存再確認。</Typography.Text>}
      </Flex>
    </>
  );
}

function HandoverDetailInner({ detail, today }: { detail: HandoverDetail; today: string }) {
  const { record, sides, cancellable, snapshot } = detail;
  const [errors, setErrors] = useState<string[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const step = handoverNextStep(record.state, 'owner', record.effectiveDate);
  const target = record.target;
  const selfManagedAccount =
    target?.kind === 'self_managed' ? detail.paymentAccounts.find((a) => a.id === target.paymentAccountId) : undefined;
  const isDraft = record.state === 'draft';

  return (
    <DetailPage
      header={{
        title: record.address,
        tag: <StatusTag kind="handover" value={record.state} />,
        back: { href: '/owner/handovers', label: '返回移交列表' },
        // TODO(MIL-108)：依 authorize() 的結果決定是否顯示「匯出移交包」
        extra: record.state === 'completed' && <ExportPackageButton href={`/owner/handovers/${record.id}/package`} />,
      }}
      notices={
        <>
          {isDraft && <ErrorList title={`這個案件目前不能移交，原因有 ${reasons.length} 項`} errors={reasons} />}
          <ErrorList title="沒有完成" errors={errors} />
        </>
      }
      nextStep={
        <NextStep
          headline={step.headline}
          owner={step.owner}
          detail={step.detail}
          tone={step.tone}
          actions={cancellable && <CancelButton id={record.id} onDone={setErrors} />}
        />
      }
      aside={
        <Card size="small" title="移交屬性">
          <Descriptions column={1} size="small">
            <Descriptions.Item label="交出方">{record.from.name}</Descriptions.Item>
            <Descriptions.Item label="接收方">{targetLabel(record.target)}</Descriptions.Item>
            <Descriptions.Item label="生效日">{record.effectiveDate ?? '未指定'}</Descriptions.Item>
            {selfManagedAccount && (
              <Descriptions.Item label="收款帳戶">
                {selfManagedAccount.label}（{selfManagedAccount.holderName}）
              </Descriptions.Item>
            )}
            <Descriptions.Item label="進度">
              <SidesStatus sides={sides} />
            </Descriptions.Item>
            <Descriptions.Item label="租賃單位 ID">{record.rentalUnitId}</Descriptions.Item>
            {record.snapshotHash && (
              <Descriptions.Item label="快照雜湊">
                <Typography.Text code className={styles.wrap}>
                  {record.snapshotHash}
                </Typography.Text>
              </Descriptions.Item>
            )}
          </Descriptions>
        </Card>
      }
    >
      {isDraft ? (
        <DraftForm detail={detail} today={today} setErrors={setErrors} onReasons={setReasons} />
      ) : (
        <Card size="small" title="移交包內容">
          <SnapshotContent snapshot={snapshot} acknowledged={record.acknowledgedMissing} />
        </Card>
      )}
    </DetailPage>
  );
}

export default function HandoverDetailView({ detail, today }: { detail: HandoverDetail; today: string }) {
  return (
    <AntApp>
      <HandoverDetailInner detail={detail} today={today} />
    </AntApp>
  );
}
