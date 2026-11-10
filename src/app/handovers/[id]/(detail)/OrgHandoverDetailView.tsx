'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Flex,
  Form,
  Input,
  Select,
  Typography,
  Upload,
  type UploadFile,
} from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import DetailPage from '@/components/page/DetailPage';
import EmptyState from '@/components/page/EmptyState';
import NextStep from '@/components/page/NextStep';
import StatusTag from '@/components/StatusTag';
import { targetLabel } from '@/lib/handover/labels';
import { handoverNextStep } from '@/lib/handover/next-step';
import type { OrgHandoverDetail } from '@/lib/handover/org-service';
import { checkHandoverPreconditions } from '@/lib/handover/preconditions';
import { EVIDENCE_FILE_MAX_BYTES, EVIDENCE_FILE_TOO_LARGE, accountHolderChanges } from '@/lib/handover/holder-change';
import { acceptHandoverAction, simulateReceiveAction, simulateReleaseAction } from '../../actions';
import { ErrorList, ExportPackageButton, SidesStatus, SnapshotContent } from '../../../owner/handovers/HandoverParts';
import styles from '../../../owner/handovers/handovers.module.css';

/** 接收方確認接手：指定生效日與收款帳戶，持有人變更時附檔案或說明。 */
function AcceptForm({
  detail,
  today,
  setErrors,
  onReasons,
}: {
  detail: OrgHandoverDetail;
  today: string;
  setErrors: (errors: string[]) => void;
  onReasons: (messages: string[]) => void;
}) {
  const { message } = AntApp.useApp();
  const { record } = detail;
  const [effectiveDate, setEffectiveDate] = useState<Dayjs | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [evidenceNote, setEvidenceNote] = useState('');
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [pending, startTransition] = useTransition();

  const account = detail.paymentAccounts.find((a) => a.id === accountId) ?? null;
  // TODO(MIL-105, MIL-107) evaluateHolderRule：檢查點在 accountHolderChanges，與伺服器端同一個函式
  const holderChanges = accountHolderChanges(detail.currentAccountHolder, account?.holderName ?? null);
  const file = fileList[0]?.originFileObj ?? null;
  const fileTooLarge = file !== null && file.size > EVIDENCE_FILE_MAX_BYTES;
  const hasEvidence = evidenceNote.trim() !== '' || file !== null;

  // 擋下原因隨選擇的生效日即時更新，和確認時伺服器端用同一個純函式
  const reasons = useMemo(
    () =>
      checkHandoverPreconditions({
        hasActiveSigningTask: detail.hasActiveSigningTask,
        target: detail.receiverFacts,
        effectiveDate: effectiveDate ? effectiveDate.format('YYYY-MM-DD') : null,
        today,
      }),
    [detail.hasActiveSigningTask, detail.receiverFacts, effectiveDate, today],
  );

  const reasonMessages = useMemo(() => reasons.map((r) => r.message), [reasons]);
  useEffect(() => onReasons(reasonMessages), [reasonMessages, onReasons]);

  const canAccept =
    reasons.length === 0 &&
    effectiveDate !== null &&
    account !== null &&
    (!holderChanges || hasEvidence) &&
    !fileTooLarge;

  const accept = () => {
    if (!effectiveDate || !account) return;
    const formData = new FormData();
    formData.set('effectiveDate', effectiveDate.format('YYYY-MM-DD'));
    formData.set('paymentAccountId', account.id);
    if (holderChanges) {
      formData.set('evidenceNote', evidenceNote);
      if (file) formData.set('evidenceFile', file);
    }
    startTransition(async () => {
      const result = await acceptHandoverAction(record.id, formData);
      if (result.ok) {
        setErrors([]);
        message.success('已確認接手，等待生效日');
      } else {
        setErrors(result.errors);
      }
    });
  };

  return (
    <>
      <Card size="small" title="移交包內容">
        <SnapshotContent snapshot={detail.snapshot!} acknowledged={record.acknowledgedMissing} />
      </Card>

      <Card size="small" title="確認接手">
        <Form layout="vertical" component="div" className={styles.formBody}>
          <Form.Item label="生效日" htmlFor="effective-date" required>
            <DatePicker
              id="effective-date"
              value={effectiveDate}
              onChange={setEffectiveDate}
              disabledDate={(d) => d.isBefore(dayjs(today), 'day')}
              className={styles.dateInput}
            />
          </Form.Item>
          <Form.Item
            label="押金與預收租金的收款帳戶"
            htmlFor="payment-account"
            required
            extra={
              detail.currentAccountHolder
                ? `目前的收款帳戶持有人是「${detail.currentAccountHolder}」。`
                : '目前沒有押金與預收租金的收款帳戶。'
            }
            className={holderChanges ? undefined : styles.flush}
          >
            <Select
              id="payment-account"
              value={accountId}
              placeholder="選擇收款帳戶"
              onChange={setAccountId}
              options={detail.paymentAccounts.map((a) => ({ value: a.id, label: `${a.label}（${a.holderName}）` }))}
            />
          </Form.Item>
          {holderChanges && account && (
            <Flex vertical gap="middle">
              <Alert
                type="warning"
                showIcon
                title={`收款帳戶持有人會從「${detail.currentAccountHolder}」改為「${account.holderName}」`}
                description="請附上證明檔案或填寫說明，擇一即可。例如匯款單，或押金與預收租金如何轉入的說明。"
              />
              <Form.Item label="證明檔案" htmlFor="evidence-file" className={styles.flush}>
                <Upload
                  id="evidence-file"
                  fileList={fileList}
                  maxCount={1}
                  beforeUpload={() => false}
                  onChange={({ fileList: next }) => setFileList(next.slice(-1))}
                >
                  <Button icon={<UploadOutlined aria-hidden />}>選擇檔案</Button>
                </Upload>
                {fileTooLarge && (
                  <Typography.Text type="danger">{EVIDENCE_FILE_TOO_LARGE}</Typography.Text>
                )}
              </Form.Item>
              <Form.Item label="說明" htmlFor="evidence-note" className={styles.flush}>
                <Input.TextArea
                  id="evidence-note"
                  value={evidenceNote}
                  autoSize={{ minRows: 2 }}
                  onChange={(e) => setEvidenceNote(e.target.value)}
                />
              </Form.Item>
            </Flex>
          )}
        </Form>
      </Card>

      <Flex>
        {/* TODO(MIL-108)：依 authorize() 的結果決定是否顯示「確認接手」 */}
        <Button type="primary" disabled={!canAccept} loading={pending} onClick={accept}>
          確認接手
        </Button>
      </Flex>
    </>
  );
}

/** 記憶體 adapter 沒有排程生效處理，用這張卡片推進狀態。換成資料庫後不顯示。 */
function SimulateCard({ detail, setErrors }: { detail: OrgHandoverDetail; setErrors: (errors: string[]) => void }) {
  const [pending, startTransition] = useTransition();
  const { state, id } = detail.record;
  if (state !== 'accepted' && state !== 'released') return null;

  const run = () =>
    startTransition(async () => {
      const result = await (state === 'accepted' ? simulateReleaseAction(id) : simulateReceiveAction(id));
      setErrors(result.ok ? [] : result.errors);
    });

  return (
    <Card title="示範操作" size="small">
      <Flex vertical gap="middle" align="start">
        <Typography.Text type="secondary">
          示範環境沒有每日的生效處理。這張卡片只在記憶體 adapter 出現，按下後模擬生效日到達。
        </Typography.Text>
        <Button loading={pending} onClick={run}>
          {state === 'accepted' ? '模擬交出側生效' : '模擬接收側完成'}
        </Button>
      </Flex>
    </Card>
  );
}

function OrgHandoverDetailInner({
  detail,
  today,
  canSimulate,
}: {
  detail: OrgHandoverDetail;
  today: string;
  canSimulate: boolean;
}) {
  const { record, role, sides, snapshot } = detail;
  const [errors, setErrors] = useState<string[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const isReceiver = role === 'receiver';
  const accepting = isReceiver && record.state === 'owner_confirmed';
  const account = record.receiverAccount;
  const evidence = account?.evidence;
  const step = handoverNextStep(record.state, isReceiver ? 'receiver' : 'releaser', record.effectiveDate);

  return (
    <DetailPage
      header={{
        title: record.address,
        tag: <StatusTag kind="handover" value={record.state} />,
        back: { href: '/handovers', label: '返回移交列表' },
        // TODO(MIL-108)：依 authorize() 的結果決定是否顯示「匯出移交包」
        extra: detail.canExport && <ExportPackageButton href={`/handovers/${record.id}/package`} />,
      }}
      notices={
        <>
          {accepting && <ErrorList title={`這個案件目前不能接手，原因有 ${reasons.length} 項`} errors={reasons} />}
          <ErrorList title="沒有完成" errors={errors} />
          {record.state === 'cancelled' && <Alert type="warning" showIcon title="屋主已取消這個移交。" />}
        </>
      }
      nextStep={<NextStep headline={step.headline} owner={step.owner} detail={step.detail} tone={step.tone} />}
      aside={
        <Card size="small" title="移交屬性">
          <Descriptions column={1} size="small">
            <Descriptions.Item label="我的角色">{isReceiver ? '接收方（移交給我的案件）' : '交出方（我交出的案件）'}</Descriptions.Item>
            <Descriptions.Item label="交出方">{record.from.name}</Descriptions.Item>
            <Descriptions.Item label="接收方">{targetLabel(record.target)}</Descriptions.Item>
            <Descriptions.Item label="生效日">{record.effectiveDate ?? '未指定'}</Descriptions.Item>
            {account && (
              <Descriptions.Item label="接收方的收款帳戶">
                {account.label}（{account.holderName}）
              </Descriptions.Item>
            )}
            {evidence && (
              <Descriptions.Item label="持有人變更的證明">
                <Flex vertical gap="small" className={styles.wrap}>
                  {evidence.file && (
                    <Typography.Text>
                      檔案 {evidence.file.name}，{Math.ceil(evidence.file.size / 1024)} KB
                    </Typography.Text>
                  )}
                  {evidence.note && <Typography.Text>{evidence.note}</Typography.Text>}
                </Flex>
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
      {accepting ? (
        <AcceptForm detail={detail} today={today} setErrors={setErrors} onReasons={setReasons} />
      ) : (
        <>
          {!isReceiver && snapshot && (
            <Alert
              type="info"
              showIcon
              title="這是快照的唯讀副本"
              description="快照在交出側生效時凍結，內容不能修改。可以用快照雜湊核對匯出的移交包。"
            />
          )}
          <Card size="small" title="移交包內容">
            {snapshot ? (
              <SnapshotContent snapshot={snapshot} acknowledged={record.acknowledgedMissing} />
            ) : (
              <EmptyState description="交出側生效時才會凍結快照。生效後這裡會出現唯讀副本。" />
            )}
          </Card>
        </>
      )}
      {canSimulate && <SimulateCard detail={detail} setErrors={setErrors} />}
    </DetailPage>
  );
}

export default function OrgHandoverDetailView(props: {
  detail: OrgHandoverDetail;
  today: string;
  canSimulate: boolean;
}) {
  return (
    <AntApp>
      <OrgHandoverDetailInner {...props} />
    </AntApp>
  );
}
