'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Empty,
  Flex,
  Form,
  Input,
  Select,
  Typography,
  Upload,
  type UploadFile,
} from 'antd';
import { ArrowLeftOutlined, UploadOutlined } from '@ant-design/icons';
import Link from 'next/link';
import dayjs, { type Dayjs } from 'dayjs';
import { targetLabel } from '@/lib/handover/labels';
import type { OrgHandoverDetail } from '@/lib/handover/org-service';
import { checkHandoverPreconditions } from '@/lib/handover/preconditions';
import { EVIDENCE_FILE_MAX_BYTES } from '@/lib/handover/store';
import { acceptHandoverAction, simulateReceiveAction, simulateReleaseAction } from '../actions';
import { ExportPackageButton, HandoverStateTag, SidesStatus, SnapshotContent } from '../../owner/handovers/HandoverParts';
import styles from '../../owner/handovers/handovers.module.css';

function ErrorList({ title, errors }: { title: string; errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <Alert
      type="error"
      showIcon
      title={title}
      description={
        <ul style={{ margin: 0, paddingInlineStart: 24 /* lg */ }}>
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      }
    />
  );
}

/** 接收方確認接手：指定生效日與收款帳戶，持有人變更時附檔案或說明。 */
function AcceptForm({ detail, today }: { detail: OrgHandoverDetail; today: string }) {
  const { message } = AntApp.useApp();
  const { record } = detail;
  const [effectiveDate, setEffectiveDate] = useState<Dayjs | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [evidenceNote, setEvidenceNote] = useState('');
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  const account = detail.paymentAccounts.find((a) => a.id === accountId) ?? null;
  // TODO(MIL-105, MIL-107) evaluateHolderRule：E 線提供後換成押金收取規則的判斷，這裡先比對持有人名稱
  const holderChanges =
    account !== null && detail.currentAccountHolder !== null && detail.currentAccountHolder !== account.holderName;
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
    <Flex vertical gap={24 /* lg */}>
      {reasons.length > 0 && (
        <ErrorList title={`這個案件目前不能接手，原因有 ${reasons.length} 項`} errors={reasons.map((r) => r.message)} />
      )}

      <Card title="移交包內容">
        <SnapshotContent snapshot={detail.snapshot!} acknowledged={record.acknowledgedMissing} />
      </Card>

      <Card title="確認接手">
        <Form layout="vertical" component="div" style={{ maxWidth: 560 }}>
          <Form.Item label="生效日" htmlFor="effective-date" required>
            <DatePicker
              id="effective-date"
              value={effectiveDate}
              onChange={setEffectiveDate}
              disabledDate={(d) => d.isBefore(dayjs(today), 'day')}
              style={{ width: '100%', maxWidth: 240 }}
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
            style={holderChanges ? undefined : { marginBottom: 0 }}
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
            <Flex vertical gap={12 /* sm */}>
              <Alert
                type="warning"
                showIcon
                title={`收款帳戶持有人會從「${detail.currentAccountHolder}」改為「${account.holderName}」`}
                description="請附上證明檔案或填寫說明，擇一即可。例如匯款單，或押金與預收租金如何轉入的說明。"
              />
              <Form.Item label="證明檔案" htmlFor="evidence-file" style={{ marginBottom: 0 }}>
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
                  <Typography.Text type="danger">檔案超過 800 KB。請壓縮後再上傳，或改填說明。</Typography.Text>
                )}
              </Form.Item>
              <Form.Item label="說明" htmlFor="evidence-note" style={{ marginBottom: 0 }}>
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

      <ErrorList title="沒有完成" errors={errors} />

      <Flex gap={8 /* xs */} wrap>
        {/* TODO(MIL-108)：依 authorize() 的結果決定是否顯示「確認接手」 */}
        <Button type="primary" disabled={!canAccept} loading={pending} onClick={accept}>
          確認接手
        </Button>
      </Flex>
    </Flex>
  );
}

/** 記憶體 adapter 沒有排程生效處理，用這張卡片推進狀態。換成資料庫後不顯示。 */
function SimulateCard({ detail }: { detail: OrgHandoverDetail }) {
  const [errors, setErrors] = useState<string[]>([]);
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
      <Flex vertical gap={12 /* sm */} align="start">
        <Typography.Text type="secondary">
          示範環境沒有每日的生效處理。這張卡片只在記憶體 adapter 出現，按下後模擬生效日到達。
        </Typography.Text>
        <Button loading={pending} onClick={run}>
          {state === 'accepted' ? '模擬交出側生效' : '模擬接收側完成'}
        </Button>
        <ErrorList title="沒有完成" errors={errors} />
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
  const isReceiver = role === 'receiver';
  const account = record.receiverAccount;
  const evidence = account?.evidence;

  return (
    <Flex vertical gap={24 /* lg */}>
      <Flex vertical gap={8 /* xs */} className={styles.wrap}>
        <Link href="/handovers">
          <ArrowLeftOutlined aria-hidden /> 移交
        </Link>
        <Flex gap={8 /* xs */} wrap align="center">
          <Typography.Title level={4} style={{ margin: 0 }}>
            {record.address}
          </Typography.Title>
          <HandoverStateTag state={record.state} />
        </Flex>
        <Typography.Text type="secondary">
          {isReceiver ? '移交給我的案件' : '我交出的案件'}，租賃單位 ID {record.rentalUnitId}
        </Typography.Text>
      </Flex>

      <Card>
        <Descriptions column={{ xs: 1, md: 2 }} size="small">
          <Descriptions.Item label="交出方">{record.from.name}</Descriptions.Item>
          <Descriptions.Item label="接收方">{targetLabel(record.target)}</Descriptions.Item>
          <Descriptions.Item label="生效日">{record.effectiveDate ?? '未指定'}</Descriptions.Item>
          {account && (
            <Descriptions.Item label="接收方的收款帳戶">
              {account.label}（{account.holderName}）
            </Descriptions.Item>
          )}
          {evidence && (
            <Descriptions.Item label="持有人變更的證明" span="filled">
              <Flex vertical gap={4 /* xxs */} className={styles.wrap}>
                {evidence.file && (
                  <Typography.Text>
                    檔案 {evidence.file.name}，{Math.ceil(evidence.file.size / 1024)} KB
                  </Typography.Text>
                )}
                {evidence.note && <Typography.Text>{evidence.note}</Typography.Text>}
              </Flex>
            </Descriptions.Item>
          )}
          <Descriptions.Item label="進度" span="filled">
            <SidesStatus sides={sides} />
          </Descriptions.Item>
          {record.snapshotHash && (
            <Descriptions.Item label="快照雜湊" span="filled">
              <Typography.Text code className={styles.wrap}>
                {record.snapshotHash}
              </Typography.Text>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      {record.state === 'released' && (
        <Alert
          type="info"
          showIcon
          title="交出側已完成，接收側處理中"
          description="交出側的分錄已寫入，這個階段不能取消。接收側完成後才能匯出移交包。"
        />
      )}
      {record.state === 'accepted' && (
        <Alert type="info" showIcon title={`已接手，等待生效日 ${record.effectiveDate}。生效時先完成交出側，再完成接收側。`} />
      )}
      {record.state === 'cancelled' && <Alert type="warning" showIcon title="屋主已取消這個移交。" />}

      {isReceiver && record.state === 'owner_confirmed' ? (
        <AcceptForm detail={detail} today={today} />
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
          <Card title="移交包內容">
            {snapshot ? (
              <SnapshotContent snapshot={snapshot} acknowledged={record.acknowledgedMissing} />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="交出側生效時才會凍結快照。生效後這裡會出現唯讀副本。"
              />
            )}
          </Card>
        </>
      )}

      {detail.canExport && (
        <Flex>
          {/* TODO(MIL-108)：依 authorize() 的結果決定是否顯示「匯出移交包」 */}
          <ExportPackageButton href={`/handovers/${record.id}/package`} />
        </Flex>
      )}

      {canSimulate && isReceiver && <SimulateCard detail={detail} />}
    </Flex>
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
