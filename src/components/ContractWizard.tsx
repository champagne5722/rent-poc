'use client';

// 建約 wizard（規格 §7）：四步分頁流程，草稿的編輯體驗一律在這裡。
// 檢核與步驟推導的純邏輯在 src/lib/contract-wizard.ts，本檔只負責蒐集輸入、呼叫 API 與畫畫面。
// 合約類型專屬的畫面（第①步物件與範本、第②步欄位、確認頁摘要）由 src/components/contract-wizard 依
// 合約類型提供（MIL-73），本檔只管步驟、儲存、簽署區與送簽，不判斷合約類型。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Descriptions, Divider, Flex, Form, Row, Col, Space, Spin, Steps, Tag, Typography } from 'antd';
import {
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  LeftOutlined,
  RightOutlined,
  SendOutlined,
} from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Contract, ContractFields, ContractRoutingConditions, SignatureField } from '@/lib/types';
import { SIGNER_ROLE_LABELS } from '@/lib/types';
import SignatureFieldEditor from '@/components/SignatureFieldEditor';
import RoutingConditionsPanel from '@/components/RoutingConditionsPanel';
import PractitionerAssignmentPanel, { type PartySignerPick } from '@/components/PractitionerAssignmentPanel';
import { wizardUiFor } from '@/components/contract-wizard';
import type { PractitionerAssignmentInput, PrintedPractitioner } from '@/lib/practitioner-assignment/seats';
import { entityPartyRoles } from '@/lib/practitioner-assignment/seats';
import type { SeatOptions } from '@/lib/practitioner-assignment/service';
import type { SendBlockReason, SendNotice } from '@/lib/send-preconditions';
import {
  DEFAULT_ROUTING,
  countFieldsBySeat,
  evaluateRouting,
  seatOfField,
  type SeatView,
} from '@/lib/signature-routing';
import { contractTypeDefinition } from '@/lib/contract-types';
import type { PartyLabels } from '@/lib/labels';
import {
  STEP_CONFIRM,
  STEP_FIELDS,
  STEP_PROPERTY,
  STEP_SIGNATURE,
  WIZARD_STEPS,
  applyPartySigner,
  applyRoutingChange,
  checkSignatureFields,
  isPartiesOnly,
  nextStepBlockReason,
  pruneAssignments,
  resumeStepIndex,
  sendBlockReasons,
  signingSequenceNotice,
  stepStatuses,
} from '@/lib/contract-wizard';

// `/contracts/new` 的第①步也用範本區，依合約類型取範本
export { TemplateNotice } from '@/components/contract-wizard';


/** 四步進度條；`/contracts/new` 的第①步也共用這一條。 */
export function WizardStepsBar({
  current,
  statuses,
}: {
  current: number;
  statuses?: ReturnType<typeof stepStatuses>;
}) {
  return (
    <Steps
      size="small"
      current={current}
      style={{ marginBottom: 16, maxWidth: 860 }}
      items={WIZARD_STEPS.map((step, index) => ({
        key: step.key,
        title: step.title,
        status: statuses?.[index],
      }))}
    />
  );
}

function CheckLine({ ok, text }: { ok: boolean; text: string }) {
  return (
    <Space size={6}>
      {ok ? <CheckCircleTwoTone twoToneColor="#52c41a" /> : <CloseCircleTwoTone twoToneColor="#ff4d4f" />}
      <Typography.Text type={ok ? undefined : 'danger'}>{text}</Typography.Text>
    </Space>
  );
}

/**
 * 簽署區檢核：每個簽署席位至少一框，並列出每一框的簽署方與頁碼。
 * 兩方簽署序列（沒有執業人員）沿用原本的檢核文字，自管租賃合約的畫面不變。
 */
function SignatureChecklist({
  fields,
  signatureFields,
  labels,
  withDetail,
}: {
  fields: ContractFields;
  signatureFields: SignatureField[];
  labels: PartyLabels;
  withDetail?: boolean;
}) {
  const evaluation = evaluateRouting(fields.routing);
  if (evaluation.ok && !isPartiesOnly(evaluation.seats)) {
    return <SeatChecklist seats={evaluation.seats} signatureFields={signatureFields} withDetail={withDetail} />;
  }
  const check = checkSignatureFields(signatureFields);
  return (
    <Space orientation="vertical" size={4}>
      <CheckLine ok={check.party_a > 0} text={`${labels.partyAFull}簽名框 ${check.party_a} 個`} />
      <CheckLine ok={check.party_b > 0} text={`${labels.partyBFull}簽名框 ${check.party_b} 個`} />
      {withDetail && signatureFields.length > 0 && (
        <Space size={4} wrap style={{ marginTop: 4 }}>
          {signatureFields.map((f) => (
            <Tag key={f.id} color={f.signer === 'party_a' ? 'blue' : 'orange'}>
              {SIGNER_ROLE_LABELS[f.signer]}・第 {f.page + 1} 頁
            </Tag>
          ))}
        </Space>
      )}
    </Space>
  );
}

/** 有執業人員的簽署序列：依簽署順序列出每個席位的簽名框數。 */
function SeatChecklist({
  seats,
  signatureFields,
  withDetail,
}: {
  seats: readonly SeatView[];
  signatureFields: SignatureField[];
  withDetail?: boolean;
}) {
  return (
    <Space orientation="vertical" size={4}>
      {countFieldsBySeat(signatureFields, seats).map(({ seat, count }) => (
        <CheckLine key={seat.ruleId} ok={count > 0} text={`${seat.fullLabel}簽名框 ${count} 個`} />
      ))}
      {withDetail && signatureFields.length > 0 && (
        <Space size={4} wrap style={{ marginTop: 4 }}>
          {signatureFields.map((f) => (
            <Tag key={f.id} color={f.signer === 'party_a' ? 'blue' : f.signer === 'party_b' ? 'orange' : undefined}>
              {seatOfField(f, seats)?.label ?? SIGNER_ROLE_LABELS[f.signer]}・第 {f.page + 1} 頁
            </Tag>
          ))}
        </Space>
      )}
    </Space>
  );
}

/** GET /api/contracts/[id]/practitioners 的回應。 */
interface PractitionerData {
  options: SeatOptions;
  assignments: PractitionerAssignmentInput[];
  printed: Record<string, PrintedPractitioner>;
  evaluation: { ok: boolean; reasons: SendBlockReason[]; notices: SendNotice[] };
}

export default function ContractWizard({ id }: { id: string }) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [contract, setContract] = useState<Contract | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [step, setStep] = useState(STEP_FIELDS);
  const [fields, setFields] = useState<ContractFields | null>(null);
  const [sigFields, setSigFields] = useState<SignatureField[]>([]);
  const [pdfVersion, setPdfVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  // 執業人員的指派（MIL-69）。草稿中可能只選了一半，存檔時只送選完的
  const [assignments, setAssignments] = useState<PractitionerAssignmentInput[]>([]);
  const [practitionerData, setPractitionerData] = useState<PractitionerData | null>(null);
  const [form] = Form.useForm();
  const initialised = useRef(false);
  // 合約類型專屬的畫面（MIL-73）。沒有畫面的合約類型在載入後說明尚未支援
  const ui = contract ? wizardUiFor(contract.contract_type) : null;

  // 指派選項、已存的指派與送簽前檢查的結果。選項與檢查依已存的草稿計算，所以存檔後要重讀
  const loadPractitioners = useCallback(
    async (syncAssignments: boolean) => {
      const res = await fetch(`/api/contracts/${id}/practitioners`);
      if (!res.ok) return;
      const { data } = (await res.json()) as { data: PractitionerData };
      setPractitionerData(data);
      if (syncAssignments) setAssignments(data.assignments);
    },
    [id]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/contracts/${id}`);
      if (!res.ok) {
        if (!cancelled) setLoadFailed(true);
        return;
      }
      const { data } = (await res.json()) as { data: Contract };
      if (cancelled || initialised.current) return;
      initialised.current = true;
      setContract(data);
      setFields(data.fields);
      setSigFields(data.signature_fields);
      // 中斷後續作：落在第一個還沒完成的步驟（規格 §7 草稿保全）
      setStep(resumeStepIndex(data));
      void loadPractitioners(true);
      const typeUi = wizardUiFor(data.contract_type);
      if (typeUi) form.setFieldsValue(typeUi.formValuesOf(data.fields));
    })();
    return () => {
      cancelled = true;
    };
  }, [id, form, loadPractitioners]);

  // 把表單當下的值併回合約欄位快照（物件相關欄位在建立草稿時已帶入，不在表單編輯）。
  // 底稿一律取 fields 狀態而非載入當時的 contract.fields：不然在第①步改過的選用條款勾選，
  // 會在第②步按下一步時被載入當時的舊快照蓋掉。
  const readFields = useCallback((): ContractFields => {
    if (!fields || !ui) throw new Error('合約尚未載入');
    return ui.mergeFormValues(fields, form.getFieldsValue(true));
  }, [fields, form, ui]);

  // 每按「下一步」自動存草稿（規格 §7 五點基線第 5 點）
  const saveDraft = useCallback(
    async (next: ContractFields, nextSigFields: SignatureField[]): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await fetch(`/api/contracts/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: next, signature_fields: nextSigFields }),
        });
        if (!res.ok) {
          message.error((await res.json()).error ?? '草稿儲存失敗');
          return false;
        }
        // 指派在欄位之後存：分流條件已存好，伺服器才驗得到席位。沒選完的不存
        const saved = pruneAssignments(next.routing, assignments).filter((a) => a.entityId && a.practitionerId);
        const assignRes = await fetch(`/api/contracts/${id}/practitioners`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignments: saved }),
        });
        if (!assignRes.ok) {
          message.error((await assignRes.json()).error ?? '執業人員指派儲存失敗');
          return false;
        }
        setPdfVersion((v) => v + 1); // 欄位與指派的改動要反映到 PDF 預覽
        await loadPractitioners(false);
        return true;
      } finally {
        setSaving(false);
      }
    },
    [id, message, assignments, loadPractitioners]
  );

  if (loadFailed) {
    return (
      <Alert
        type="error"
        showIcon
        message="合約不存在"
        action={
          <Link href="/contracts">
            <Button size="small">回合約列表</Button>
          </Link>
        }
      />
    );
  }
  if (!contract || !fields) return <Spin style={{ display: 'block', margin: '64px auto' }} />;

  if (!ui) {
    return (
      <Alert
        type="warning"
        showIcon
        message="這個合約類型尚未支援建約流程"
        action={
          <Link href="/contracts">
            <Button size="small">回合約列表</Button>
          </Link>
        }
      />
    );
  }

  if (contract.status !== 'draft') {
    return (
      <Alert
        type="warning"
        showIcon
        message="此合約已送簽，不能再用建約流程編輯"
        description="修約請先撤回，再複製為新草稿重新編輯送簽。"
        action={
          <Link href={`/contracts/${contract.id}`}>
            <Button size="small" type="primary">
              前往合約詳情
            </Button>
          </Link>
        }
      />
    );
  }

  // 指派還沒從伺服器讀回來之前不檢查指派，避免步驟列閃一下錯誤
  const contractType = contract.contract_type;
  const labels = contractTypeDefinition(contractType).labels;
  const state = {
    contractType,
    fields,
    signatureFields: sigFields,
    assignments: practitionerData ? assignments : undefined,
  };
  const routingEvaluation = evaluateRouting(fields.routing);
  const seats = routingEvaluation.ok ? routingEvaluation.seats : undefined;
  const partiesOnly = !seats || isPartiesOnly(seats);
  // 有執業人員的簽署序列才在確認頁列出擋下原因並停用送簽；兩方序列沿用原本的行為（送簽時才提示）
  // 伺服器的送簽前檢查（資格、專任、Email 重複等）接在後面，同一句不重複列
  const serverReasons = practitionerData?.evaluation.reasons.map((r) => r.message) ?? [];
  const sendReasons = partiesOnly ? [] : [...new Set([...sendBlockReasons(state), ...serverReasons])];
  const renewalNotices = practitionerData?.evaluation.notices ?? [];
  const lockedPartyRoles = routingEvaluation.ok ? entityPartyRoles(routingEvaluation.plan) : [];

  const goNext = async () => {
    const nextFields = step === STEP_FIELDS ? readFields() : fields;
    const blocked = nextStepBlockReason(step, { contractType, fields: nextFields, signatureFields: sigFields, assignments });
    if (blocked) {
      message.error(blocked);
      // 第②步同時觸發表單的欄位錯誤提示
      if (step === STEP_FIELDS) form.validateFields().catch(() => {});
      return;
    }
    setFields(nextFields);
    if (!(await saveDraft(nextFields, sigFields))) return;
    setStep(step + 1);
  };

  // 合約類型畫面改欄位：先放記憶體，按「下一步」時隨草稿一起存
  const changeFields = (next: ContractFields) => setFields(next);

  // 改欄位並立刻存檔（例如升版重建，出租人按了才會動）
  const commitFields = async (next: ContractFields, successMessage: string) => {
    setFields(next);
    if (await saveDraft(next, sigFields)) message.success(successMessage);
  };

  // 第①步改分流條件：寫入 fields.routing，並依新的簽署序列整理簽署區域，按「下一步」時隨草稿存回
  const changeRouting = (routing: ContractRoutingConditions) => {
    const next = applyRoutingChange(fields, sigFields, routing);
    setFields(next.fields);
    setSigFields(next.signatureFields);
    setAssignments(pruneAssignments(routing, assignments));
    if (next.removed > 0) message.warning(`簽署序列已沒有對應的席位，已移除 ${next.removed} 個簽署區域`);
  };

  // 選定當事人簽署人後，那一方的姓名與 Email 由簽署人帶入，不開放手填（ADR-0018 決議 2）
  const pickPartySigner = ({ role, signer }: PartySignerPick) => {
    const person = signer ?? { name: '', email: '' };
    setFields((current) => (current ? applyPartySigner(current, role, person, contractType) : current));
    form.setFieldsValue(ui.partyFormValues(role, person));
  };

  // 執業人員指派區：簽署序列有執業人員席位時才有，放在第②步雙方資訊之後
  const practitionerSlot = partiesOnly ? null : (
              <>
                <Divider />
                <Flex vertical gap={12}>
                  {lockedPartyRoles.length > 0 && (
                    <Typography.Text type="secondary">
                      {lockedPartyRoles.map((role) => SIGNER_ROLE_LABELS[role]).join('、')}是執業主體，姓名與 Email
                      由下方選定的當事人簽署人帶入。
                    </Typography.Text>
                  )}
                  <PractitionerAssignmentPanel
                    options={practitionerData?.options ?? null}
                    assignments={assignments}
                    onChange={setAssignments}
                    onPartySigner={pickPartySigner}
                    disabled={saving}
                  />
                </Flex>
                <Divider />
              </>
  );

  const goPrev = () => {
    if (step === STEP_FIELDS) setFields(readFields());
    setStep(step - 1);
  };

  const send = async () => {
    const [blocked] = sendBlockReasons(state);
    if (blocked) {
      message.error(blocked);
      return;
    }
    if (!(await saveDraft(fields, sigFields))) return;
    setSending(true);
    const res = await fetch(`/api/contracts/${id}/send`, { method: 'POST' });
    const json = await res.json();
    setSending(false);
    if (!res.ok) {
      message.error(json.error ?? '送簽失敗');
      return;
    }
    message.success(json.data.mock ? '已送簽（mock 模式，未實際呼叫點點簽）' : '已送出至點點簽');
    router.push(`/contracts/${id}`);
  };

  const summaryItems = [
    ...ui.summaryItems(fields, { labels }),
    ...(seats && !partiesOnly
      ? [
          {
            key: 'practitioners',
            label: '執業人員',
            span: 2,
            children: Object.keys(practitionerData?.printed ?? {}).length ? (
              <Space orientation="vertical" size={2}>
                {Object.entries(practitionerData?.printed ?? {}).map(([slot, p]) => (
                  <Typography.Text key={slot}>
                    {p.name}
                    {p.title ? `（${p.title}）` : ''}・{p.entityName}
                  </Typography.Text>
                ))}
              </Space>
            ) : (
              '（尚未指派）'
            ),
          },
          {
            key: 'routing',
            label: '簽署序列',
            span: 2,
            children: seats.map((seat) => seat.fullLabel).join(' → '),
          },
        ]
      : []),
    {
      key: 'signature',
      label: '簽署區',
      span: 2,
      children: <SignatureChecklist fields={fields} signatureFields={sigFields} labels={labels} withDetail />,
    },
  ];

  return (
    <>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          建立合約 — 草稿 #{contract.id}
        </Typography.Title>
        <Link href="/contracts">
          <Button size="small">先離開（草稿已保留）</Button>
        </Link>
      </Space>

      <WizardStepsBar current={step} statuses={stepStatuses(step, state)} />

      {step === STEP_PROPERTY && (
        <Card size="small" style={{ maxWidth: 760 }}>
          <ui.PropertyStep
            fields={fields}
            routingPanel={
              <Flex vertical gap={12} style={{ marginBottom: 12 }}>
                <RoutingConditionsPanel value={fields.routing ?? DEFAULT_ROUTING} onChange={changeRouting} disabled={saving} />
              </Flex>
            }
            saving={saving}
            onFieldsChange={changeFields}
            onCommitFields={commitFields}
          />
        </Card>
      )}

      {step === STEP_FIELDS && (
        <Card size="small" style={{ maxWidth: 760 }}>
          <ui.FieldsStep
            form={form}
            fields={fields}
            labels={labels}
            lockedPartyRoles={lockedPartyRoles}
            practitionerSlot={practitionerSlot}
            onFieldsChange={changeFields}
          />
        </Card>
      )}

      {step === STEP_SIGNATURE && (
        <Row gutter={16}>
          <Col span={17}>
            <Card
              size="small"
              title={partiesOnly ? '在預覽上為甲乙雙方各拖放至少一個簽名框' : '在預覽上為每個簽署席位各拖放至少一個簽名框'}
            >
              <SignatureFieldEditor
                pdfUrl={`/api/contracts/${id}/pdf?v=${pdfVersion}`}
                value={sigFields}
                onChange={setSigFields}
                seats={seats}
              />
            </Card>
          </Col>
          <Col span={7}>
            <Card size="small" title="簽署區檢核">
              <SignatureChecklist fields={fields} signatureFields={sigFields} labels={labels} withDetail />
            </Card>
          </Col>
        </Row>
      )}

      {step === STEP_CONFIRM && (
        <Card size="small" style={{ maxWidth: 860 }}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={partiesOnly ? '乙方先簽' : '依序簽署'}
            description={signingSequenceNotice(fields, contractType)}
          />
          <ui.ConfirmNotices fields={fields} />
          {renewalNotices.map((notice) => (
            <Alert key={notice.seatRuleId} type="warning" showIcon style={{ marginBottom: 12 }} title="換證期限將到" description={`${notice.message}。換證窗口內仍可送簽。`} />
          ))}
          {sendReasons.length > 0 && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              title="目前無法送簽，請先處理下列事項"
              description={
                <Space orientation="vertical" size={4}>
                  {sendReasons.map((reason) => (
                    <Typography.Text key={reason}>・{reason}</Typography.Text>
                  ))}
                </Space>
              }
            />
          )}
          <Descriptions column={2} size="small" bordered items={summaryItems} />
        </Card>
      )}

      <Space style={{ marginTop: 16 }}>
        {step > STEP_PROPERTY && (
          <Button icon={<LeftOutlined />} onClick={goPrev} disabled={saving || sending}>
            上一步
          </Button>
        )}
        {step < STEP_CONFIRM && (
          <Button type="primary" loading={saving} onClick={goNext}>
            下一步 <RightOutlined />
          </Button>
        )}
        {step === STEP_CONFIRM && (
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={saving || sending}
            disabled={sendReasons.length > 0}
            onClick={send}
          >
            確認送簽
          </Button>
        )}
      </Space>
    </>
  );
}
