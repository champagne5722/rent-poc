'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  Alert,
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
  Tag,
  Typography,
  theme,
} from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import Link from 'next/link';
import dayjs, { type Dayjs } from 'dayjs';
import {
  PRACTICE_ENTITY_STATUS_LABELS,
  RECEIVER_MANDATE_LABELS,
  formatSnapshotValue,
  targetLabel,
} from '@/lib/handover/labels';
import { checkHandoverPreconditions, type HandoverTargetFacts } from '@/lib/handover/preconditions';
import type { ConfirmTargetInput, HandoverDetail } from '@/lib/handover/service';
import { missingKey, type HandoverManualFields, type HandoverSnapshot } from '@/lib/handover/snapshot';
import { cancelHandoverAction, confirmHandoverAction, saveManualFieldsAction } from '../actions';
import { HandoverStateTag, SidesStatus } from '../HandoverParts';
import styles from '../handovers.module.css';

const NEXT_STEP: Partial<Record<HandoverDetail['record']['state'], string>> = {
  owner_confirmed: '等待新受託人確認接手並指定生效日。',
  accepted: '等待生效日。生效日到達時，系統會先完成交出側，再完成接收側。',
  released: '交出側已生效，等待接收側完成。這個階段不能取消。',
};

function SnapshotContent({
  snapshot,
  acknowledged = [],
}: {
  snapshot: HandoverSnapshot;
  /** 屋主確認時勾選知悉的缺項，確認後在缺項旁標示。 */
  acknowledged?: string[];
}) {
  const { token } = theme.useToken();
  return (
    <div className={styles.categories} style={{ ['--handover-hairline' as string]: token.colorSplit }}>
      {snapshot.categories.map((category) => (
        <section key={category.key} aria-labelledby={`cat-${category.key}`}>
          <Typography.Title level={5} id={`cat-${category.key}`} style={{ marginTop: 0 }}>
            {category.label}
          </Typography.Title>
          {category.items.map((item) => (
            <div key={item.key} className={styles.itemRow}>
              <Typography.Text type="secondary">{item.label}</Typography.Text>
              <span className={styles.wrap}>
                {item.status === 'present' && <Typography.Text>{formatSnapshotValue(category.key, item)}</Typography.Text>}
                {item.status === 'missing' && (
                  <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                    {acknowledged.includes(missingKey(category.key, item.key)) ? '缺項，屋主已知悉' : '缺項'}
                  </Tag>
                )}
                {item.status === 'not_applicable' && <Typography.Text type="secondary">不適用（沒有租賃案件）</Typography.Text>}
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

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

function DraftForm({ detail, today }: { detail: HandoverDetail; today: string }) {
  const { message } = AntApp.useApp();
  const { record, snapshot } = detail;
  const [manual, setManual] = useState<HandoverManualFields>(record.manual);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [kind, setKind] = useState<TargetKind | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [effectiveDate, setEffectiveDate] = useState<Dayjs | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [evidenceNote, setEvidenceNote] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
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
    <Flex vertical gap={24 /* lg */}>
      {reasons.length > 0 && (
        <Alert
          type="error"
          showIcon
          title={`這個案件目前不能移交，原因有 ${reasons.length} 項`}
          description={
            <ul style={{ margin: 0, paddingInlineStart: 24 /* lg */ }}>
              {reasons.map((reason) => (
                <li key={reason.code}>{reason.message}</li>
              ))}
            </ul>
          }
        />
      )}

      <Card title="移交包內容">
        <SnapshotContent snapshot={snapshot} />
      </Card>

      <Card title="實物與行政（手填）">
        <Form layout="vertical" component="div" style={{ maxWidth: 560 }}>
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

      <Card title={`缺項（${snapshot.missing.length}）`}>
        {snapshot.missing.length === 0 ? (
          <Typography.Text type="secondary">沒有缺項。</Typography.Text>
        ) : (
          <Flex vertical gap={12 /* sm */}>
            <Typography.Text type="secondary">
              缺項不會中斷移交，但每一項都要勾選知悉才能確認。缺項會列在移交包的索引。
            </Typography.Text>
            <Checkbox.Group value={acknowledged} onChange={(values) => setAcknowledged(values as string[])}>
              <Flex vertical gap={8 /* xs */}>
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

      <Card title="誰接手">
        <Flex vertical gap={16 /* md */}>
          <Radio.Group value={kind} onChange={(e) => setKind(e.target.value)}>
            <Flex vertical gap={8 /* xs */}>
              <Radio value="mandatary">交給新受託人</Radio>
              <Radio value="self_managed">改為自管</Radio>
            </Flex>
          </Radio.Group>

          {kind === 'mandatary' && (
            <Form layout="vertical" component="div" style={{ maxWidth: 560 }}>
              <Form.Item
                label="新受託人"
                htmlFor="receiver"
                extra="生效日與收款帳戶由新受託人在確認接手時指定。"
                style={{ marginBottom: 0 }}
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
            <Form layout="vertical" component="div" style={{ maxWidth: 560 }}>
              <Form.Item label="生效日" htmlFor="effective-date">
                <DatePicker
                  id="effective-date"
                  value={effectiveDate}
                  onChange={setEffectiveDate}
                  disabledDate={(d) => d.isBefore(dayjs(today), 'day')}
                  style={{ width: '100%', maxWidth: 240 }}
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
                  style={{ marginBottom: 0 }}
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

      {errors.length > 0 && (
        <Alert
          type="error"
          showIcon
          title="沒有完成"
          description={
            <ul style={{ margin: 0, paddingInlineStart: 24 /* lg */ }}>
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          }
        />
      )}

      <Flex vertical gap={8 /* xs */}>
        <Flex gap={8 /* xs */} wrap>
          {/* TODO(MIL-108)：依 authorize() 的結果決定是否顯示「確認移交」 */}
          <Button type="primary" disabled={!canConfirm} loading={confirming} onClick={confirm}>
            確認移交
          </Button>
          <CancelButton id={record.id} onDone={setErrors} />
        </Flex>
        {manualDirty && <Typography.Text type="secondary">手填欄位有變更，先儲存再確認。</Typography.Text>}
      </Flex>
    </Flex>
  );
}

function HandoverDetailInner({ detail, today }: { detail: HandoverDetail; today: string }) {
  const { record, sides, cancellable, snapshot } = detail;
  const [errors, setErrors] = useState<string[]>([]);
  const nextStep = NEXT_STEP[record.state];
  const target = record.target;
  const selfManagedAccount =
    target?.kind === 'self_managed' ? detail.paymentAccounts.find((a) => a.id === target.paymentAccountId) : undefined;

  return (
    <Flex vertical gap={24 /* lg */}>
      <Flex vertical gap={8 /* xs */} className={styles.wrap}>
        <Link href="/owner/handovers">
          <ArrowLeftOutlined aria-hidden /> 移交
        </Link>
        <Flex gap={8 /* xs */} wrap align="center">
          <Typography.Title level={4} style={{ margin: 0 }}>
            {record.address}
          </Typography.Title>
          <HandoverStateTag state={record.state} />
        </Flex>
        <Typography.Text type="secondary">租賃單位 ID {record.rentalUnitId}</Typography.Text>
      </Flex>

      <Card>
        <Descriptions column={{ xs: 1, md: 2 }} size="small">
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
          {record.snapshotHash && (
            <Descriptions.Item label="快照雜湊" span="filled">
              <Typography.Text code className={styles.wrap}>{record.snapshotHash}</Typography.Text>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      {record.state === 'draft' ? (
        <DraftForm detail={detail} today={today} />
      ) : (
        <>
          {nextStep && <Alert type="info" showIcon title={nextStep} />}
          {errors.length > 0 && <Alert type="error" showIcon title={errors.join(' ')} />}
          <Card title="移交包內容">
            <SnapshotContent snapshot={snapshot} acknowledged={record.acknowledgedMissing} />
          </Card>
          {cancellable && (
            <Flex>
              <CancelButton id={record.id} onDone={setErrors} />
            </Flex>
          )}
        </>
      )}
    </Flex>
  );
}

export default function HandoverDetailView({ detail, today }: { detail: HandoverDetail; today: string }) {
  return (
    <AntApp>
      <HandoverDetailInner detail={detail} today={today} />
    </AntApp>
  );
}
