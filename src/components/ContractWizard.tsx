'use client';

// 建約 wizard（規格 §7）：四步分頁流程，草稿的編輯體驗一律在這裡。
// 檢核與步驟推導的純邏輯在 src/lib/contract-wizard.ts，本檔只負責蒐集輸入、呼叫 API 與畫畫面。
// 合約類型專屬的畫面（第①步物件與範本、第②步欄位、確認頁摘要）由 src/components/contract-wizard 依
// 合約類型提供（MIL-73），本檔只管步驟、儲存、簽署區與送簽，不判斷合約類型。
// 首屏資料由 server component 載入（src/lib/contract-wizard-load.ts，MIL-176），這裡不在掛載時打 API。
// 版型（固定的步驟條與按鈕列、草稿儲存狀態、整體錯誤）在 contract-wizard/WizardFrame。欄位錯誤顯示在欄位旁，整體錯誤用頁內 Alert。

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Descriptions, Flex, Form, Row, Col, Space, Tag, Typography } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, LeftOutlined, RightOutlined, SendOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Contract, ContractFields, ContractRoutingConditions, SignatureField } from '@/lib/types';
import type { MandateItem } from '@/lib/mandate-schedule';
import type { PdfPageMap } from '@/lib/pdf-layout';
import { SIGNER_ROLE_LABELS } from '@/lib/types';
import SignatureFieldEditor from '@/components/SignatureFieldEditor';
import RoutingConditionsPanel from '@/components/RoutingConditionsPanel';
import PractitionerAssignmentPanel, { type PartySignerPick } from '@/components/PractitionerAssignmentPanel';
import { wizardUiFor } from '@/components/contract-wizard';
import WizardFrame, { type DraftState } from '@/components/contract-wizard/WizardFrame';
import type { PractitionerPayload } from '@/lib/practitioner-assignment/payload';
import type { PractitionerAssignmentInput } from '@/lib/practitioner-assignment/seats';
import { entityPartyRoles } from '@/lib/practitioner-assignment/seats';
import {
  DEFAULT_ROUTING,
  countFieldsBySeat,
  evaluateRouting,
  seatOfField,
  signerChainLabels,
  type SeatView,
} from '@/lib/signature-routing';
import { contractTypeDefinition } from '@/lib/contract-types';
import { shortUlid } from '@/lib/pg/ulid';
import type { ContractType, PartyLabels } from '@/lib/labels';
import {
  STEP_CONFIRM,
  STEP_FIELDS,
  STEP_PROPERTY,
  STEP_SIGNATURE,
  applyPartySigner,
  applyRoutingChange,
  checkSignatureFields,
  isPartiesOnly,
  nextStepBlockReason,
  pruneAssignments,
  resumeStepIndex,
  sendBlockReasons,
  signingSequenceNotice,
  signingSequenceTitle,
  stepStatuses,
} from '@/lib/contract-wizard';
import styles from './ContractWizard.module.css';

function CheckLine({ ok, text }: { ok: boolean; text: string }) {
  return (
    <Typography.Text type={ok ? 'success' : 'danger'}>
      <Space size="small">
        {ok ? <CheckCircleOutlined aria-label="已完成" /> : <CloseCircleOutlined aria-label="未完成" />}
        {text}
      </Space>
    </Typography.Text>
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
  contractType,
  withDetail,
  pages,
}: {
  fields: ContractFields;
  signatureFields: SignatureField[];
  labels: PartyLabels;
  contractType: ContractType;
  withDetail?: boolean;
  /** 簽署區編輯器回報的頁面地圖。有現況確認附件頁時，另列附件頁的簽名框。 */
  pages?: PdfPageMap | null;
}) {
  const evaluation = evaluateRouting(fields.routing, contractType);
  if (evaluation.ok && !isPartiesOnly(evaluation.seats)) {
    return <SeatChecklist seats={evaluation.seats} signatureFields={signatureFields} withDetail={withDetail} pages={pages} />;
  }
  const check = checkSignatureFields(signatureFields);
  return (
    <Flex vertical gap="small">
      <Flex vertical gap={4}>
        <CheckLine ok={check.party_a > 0} text={`${labels.partyAFull}簽名框 ${check.party_a} 個`} />
        <CheckLine ok={check.party_b > 0} text={`${labels.partyBFull}簽名框 ${check.party_b} 個`} />
      </Flex>
      {withDetail && signatureFields.length > 0 && (
        <Flex wrap gap={4} className={styles.chips}>
          {signatureFields.map((f) => (
            <Tag key={f.id}>
              {SIGNER_ROLE_LABELS[f.signer]}・第 {f.page + 1} 頁
            </Tag>
          ))}
        </Flex>
      )}
    </Flex>
  );
}

/** 有執業人員的簽署序列：依簽署順序列出每個席位的簽名框數。 */
function SeatChecklist({
  seats,
  signatureFields,
  withDetail,
  pages,
}: {
  seats: readonly SeatView[];
  signatureFields: SignatureField[];
  withDetail?: boolean;
  pages?: PdfPageMap | null;
}) {
  const annexPage = pages?.statusAnnexPage ?? null;
  return (
    <Flex vertical gap="small">
      <Flex vertical gap={4}>
        {countFieldsBySeat(signatureFields, seats).map(({ seat, count }) => (
          <CheckLine key={seat.ruleId} ok={count > 0} text={`${seat.fullLabel}簽名框 ${count} 個`} />
        ))}
        {annexPage !== null &&
          seats
            .filter((seat) => seat.requiresStatusAnnex)
            .map((seat) => {
              const count = signatureFields.filter((f) => f.page === annexPage && seatOfField(f, seats)?.ruleId === seat.ruleId).length;
              return <CheckLine key={`annex-${seat.ruleId}`} ok={count > 0} text={`現況確認附件頁：${seat.fullLabel}簽名框 ${count} 個`} />;
            })}
      </Flex>
      {withDetail && signatureFields.length > 0 && (
        <Flex wrap gap={4} className={styles.chips}>
          {signatureFields.map((f) => (
            <Tag key={f.id}>
              {seatOfField(f, seats)?.label ?? SIGNER_ROLE_LABELS[f.signer]}・第 {f.page + 1} 頁
            </Tag>
          ))}
        </Flex>
      )}
    </Flex>
  );
}

/** 精靈的首屏資料，由 server component 載入（src/lib/contract-wizard-load.ts）。 */
export interface ContractWizardInitial {
  contract: Contract;
  /** 委託標的清單。沒有清單的合約類型是 null。 */
  mandateItems: MandateItem[] | null;
  /** 指派資料。分流條件無效時是 null。 */
  practitioners: PractitionerPayload | null;
}

function ContractWizardInner({ initial }: { initial: ContractWizardInitial }) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const { contract } = initial;
  // 合約類型專屬的畫面（MIL-73）。沒有畫面的合約類型說明尚未支援
  const ui = wizardUiFor(contract.contract_type);
  // 中斷後續作：落在第一個還沒完成的步驟（規格 §7 草稿保全）。委託標的清單存在子表，續作要落在哪一步取決於清單是否齊全
  const [step, setStep] = useState(() =>
    resumeStepIndex(contract, initial.mandateItems ? { mandateItems: initial.mandateItems } : undefined),
  );
  const [fields, setFields] = useState<ContractFields>(contract.fields);
  const [sigFields, setSigFields] = useState<SignatureField[]>(contract.signature_fields);
  const [pdfVersion, setPdfVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  // 整體錯誤（頁內 Alert）：擋下一步的原因、儲存與送簽失敗。欄位錯誤由表單顯示在欄位旁
  const [stepError, setStepError] = useState<string | null>(null);
  // 草稿的儲存狀態：載入時伺服端已有這份草稿；改了還沒存是 dirty，上一次儲存失敗是 saveFailed
  const [dirty, setDirty] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // 執業人員的指派（MIL-69）。草稿中可能只選了一半，存檔時只送選完的
  const [assignments, setAssignments] = useState<PractitionerAssignmentInput[]>(initial.practitioners?.assignments ?? []);
  const [practitionerData, setPractitionerData] = useState<PractitionerPayload | null>(initial.practitioners);
  // 委託標的清單（MIL-74）。只有委託管理合約有
  const [mandateItems, setMandateItems] = useState<MandateItem[] | null>(initial.mandateItems);
  // 簽署區編輯器讀 PDF 後回報的頁面地圖（MIL-71）：附件頁在哪一頁。沒開過編輯器時是 null
  const [pageMap, setPageMap] = useState<PdfPageMap | null>(null);
  const [form] = Form.useForm();
  const formSeeded = useRef(false);

  // 欄位表單第一次出現時填入草稿的值。表單掛上之後才填，所以放在 layout effect，不會閃一下空白
  useLayoutEffect(() => {
    if (step !== STEP_FIELDS || formSeeded.current || !ui) return;
    formSeeded.current = true;
    form.setFieldsValue(ui.formValuesOf(contract.fields));
  }, [step, ui, form, contract.fields]);

  // 指派選項與送簽前檢查依已存的草稿計算，所以存檔後要重讀。這是操作後的更新，首屏資料由 server component 載入
  const loadPractitioners = useCallback(
    async (syncAssignments: boolean) => {
      const res = await fetch(`/api/contracts/${contract.id}/practitioners`);
      if (!res.ok) return;
      const { data } = (await res.json()) as { data: PractitionerPayload };
      setPractitionerData(data);
      if (syncAssignments) setAssignments(data.assignments);
    },
    [contract.id],
  );

  // 把表單當下的值併回合約欄位快照（物件相關欄位在建立草稿時已帶入，不在表單編輯）。
  // 底稿一律取 fields 狀態而非載入當時的 contract.fields：不然在第①步改過的選用條款勾選，
  // 會在第②步按下一步時被載入當時的舊快照蓋掉。
  const readFields = useCallback((): ContractFields => {
    if (!ui) throw new Error('這個合約類型尚未支援建約流程');
    return ui.mergeFormValues(fields, form.getFieldsValue(true));
  }, [fields, form, ui]);

  // 每按「下一步」自動存草稿（規格 §7 五點基線第 5 點）
  const saveDraft = useCallback(
    async (next: ContractFields, nextSigFields: SignatureField[]): Promise<boolean> => {
      setSaving(true);
      const fail = (reason: string) => {
        setStepError(reason);
        setSaveFailed(true);
        return false;
      };
      try {
        const res = await fetch(`/api/contracts/${contract.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: next, signature_fields: nextSigFields }),
        });
        if (!res.ok) return fail((await res.json()).error ?? '草稿儲存失敗');
        // 指派在欄位之後存：分流條件已存好，伺服器才驗得到席位。沒選完的不存
        const saved = pruneAssignments(next.routing, assignments, contract.contract_type).filter(
          (a) => a.entityId && a.practitionerId,
        );
        const assignRes = await fetch(`/api/contracts/${contract.id}/practitioners`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignments: saved }),
        });
        if (!assignRes.ok) return fail((await assignRes.json()).error ?? '執業人員指派儲存失敗');
        // 當事人簽署人的 Email 由伺服端存指派時補進合約欄位（MIL-200），瀏覽器只知道姓名。存完後把伺服端補好的欄位讀回來
        if (saved.some((a) => a.partySignerId)) {
          const fresh = await fetch(`/api/contracts/${contract.id}`);
          if (fresh.ok) {
            const { data } = (await fresh.json()) as { data: Contract };
            setFields(data.fields);
            if (ui) form.setFieldsValue(ui.formValuesOf(data.fields));
          }
        }
        // 委託標的清單在欄位與指派之後存。請求只帶租賃單位與範圍，快照由伺服器取，回傳的清單換掉記憶體裡的
        if (ui?.hasMandateItems && mandateItems) {
          const itemsRes = await fetch(`/api/contracts/${contract.id}/mandate-items`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: mandateItems.map(({ propertyId, scopes }) => ({ propertyId, scopes })) }),
          });
          if (!itemsRes.ok) return fail((await itemsRes.json()).error ?? '委託標的清單儲存失敗');
          setMandateItems(((await itemsRes.json()) as { data: { items: MandateItem[] } }).data.items);
        }
        setPdfVersion((v) => v + 1); // 欄位、指派與清單的改動要反映到 PDF 預覽
        await loadPractitioners(false);
        setDirty(false);
        setSaveFailed(false);
        return true;
      } finally {
        setSaving(false);
      }
    },
    [contract.id, contract.contract_type, assignments, loadPractitioners, ui, mandateItems, form],
  );

  if (!ui) {
    return (
      <Alert
        type="warning"
        showIcon
        title="這個合約類型尚未支援建約流程"
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
        title="此合約已送簽，不能再用建約流程編輯"
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
  const definition = contractTypeDefinition(contractType);
  const labels = definition.labels;
  const state = {
    contractType,
    fields,
    signatureFields: sigFields,
    assignments: practitionerData ? assignments : undefined,
    mandateItems: mandateItems ?? undefined,
    pages: pageMap ?? undefined,
  };
  const routingEvaluation = evaluateRouting(fields.routing, contractType);
  const seats = routingEvaluation.ok ? routingEvaluation.seats : undefined;
  const partiesOnly = !seats || isPartiesOnly(seats);
  // 有執業人員的簽署序列才在確認頁列出擋下原因並停用送簽；兩方序列沿用原本的行為（送簽時才提示）
  // 伺服器的送簽前檢查（資格、專任、Email 重複等）接在後面，同一句不重複列
  const serverReasons = practitionerData?.evaluation.reasons.map((r) => r.message) ?? [];
  const sendReasons = partiesOnly ? [] : [...new Set([...sendBlockReasons(state), ...serverReasons])];
  const renewalNotices = practitionerData?.evaluation.notices ?? [];
  const lockedPartyRoles = routingEvaluation.ok ? entityPartyRoles(routingEvaluation.plan) : [];

  const draft: DraftState = saving || sending ? 'saving' : saveFailed ? 'failed' : dirty ? 'unsaved' : 'saved';

  const goNext = async () => {
    setStepError(null);
    const nextFields = step === STEP_FIELDS ? readFields() : fields;
    const blocked = nextStepBlockReason(step, {
      contractType,
      fields: nextFields,
      signatureFields: sigFields,
      assignments,
      mandateItems: mandateItems ?? undefined,
      pages: pageMap ?? undefined,
    });
    if (blocked) {
      setStepError(blocked);
      // 第②步同時觸發表單的欄位錯誤提示，顯示在欄位旁
      if (step === STEP_FIELDS) form.validateFields().catch(() => {});
      return;
    }
    setFields(nextFields);
    if (!(await saveDraft(nextFields, sigFields))) return;
    setStep(step + 1);
  };

  const markDirty = () => setDirty(true);

  // 合約類型畫面改欄位：先放記憶體，按「下一步」時隨草稿一起存
  const changeFields = (next: ContractFields) => {
    setFields(next);
    markDirty();
  };

  // 改欄位並立刻存檔（例如升版重建，出租人按了才會動）
  const commitFields = async (next: ContractFields, successMessage: string) => {
    setStepError(null);
    setFields(next);
    if (await saveDraft(next, sigFields)) message.success(successMessage);
  };

  // 第①步改分流條件：寫入 fields.routing，並依新的簽署序列整理簽署區域，按「下一步」時隨草稿存回
  const changeRouting = (routing: ContractRoutingConditions) => {
    const next = applyRoutingChange(fields, sigFields, routing, contractType);
    setFields(next.fields);
    setSigFields(next.signatureFields);
    setAssignments(pruneAssignments(routing, assignments, contractType));
    markDirty();
    if (next.removed > 0) message.warning(`簽署序列已沒有對應的席位，已移除 ${next.removed} 個簽署區域`);
  };

  // 選定當事人簽署人後，那一方的姓名由簽署人帶入，不開放手填（ADR-0018 決議 2）。
  // Email 不經過瀏覽器：存指派時由伺服端依所選的人補進合約欄位（MIL-200）
  const pickPartySigner = ({ role, signer }: PartySignerPick) => {
    const person = { name: signer?.name ?? '', email: '' };
    setFields((current) => applyPartySigner(current, role, person, contractType));
    form.setFieldsValue(ui.partyFormValues(role, person));
    markDirty();
  };

  // 執業人員指派區：簽署序列有執業人員席位時才有，放在第②步雙方資訊之後
  const practitionerSlot = partiesOnly ? null : (
    <Flex vertical gap="small">
      {lockedPartyRoles.length > 0 && (
        <Typography.Text type="secondary">
          {lockedPartyRoles.map((role) => SIGNER_ROLE_LABELS[role]).join('、')}是執業主體，姓名與 Email 由下方選定的當事人簽署人帶入。
        </Typography.Text>
      )}
      <PractitionerAssignmentPanel
        options={practitionerData?.options ?? null}
        assignments={assignments}
        onChange={(next) => {
          setAssignments(next);
          markDirty();
        }}
        onPartySigner={pickPartySigner}
        merges={practitionerData?.evaluation.merges}
        disabled={saving}
      />
    </Flex>
  );

  const goPrev = () => {
    setStepError(null);
    if (step === STEP_FIELDS) setFields(readFields());
    setStep(step - 1);
  };

  const send = async () => {
    setStepError(null);
    const [blocked] = sendBlockReasons(state);
    if (blocked) {
      setStepError(blocked);
      return;
    }
    if (!(await saveDraft(fields, sigFields))) return;
    setSending(true);
    const res = await fetch(`/api/contracts/${contract.id}/send`, { method: 'POST' });
    const json = await res.json();
    setSending(false);
    if (!res.ok) {
      setStepError(json.error ?? '送簽失敗');
      return;
    }
    message.success(json.data.mock ? '已送簽（mock 模式，未實際呼叫點點簽）' : '已送出至點點簽');
    router.push(`/contracts/${contract.id}`);
  };

  const summaryItems = [
    ...ui.summaryItems(fields, { labels, contractId: contract.id, mandateItems: mandateItems ?? [] }),
    ...(seats && !partiesOnly
      ? [
          {
            key: 'practitioners',
            label: '執業人員',
            span: 2,
            children: Object.keys(practitionerData?.printed ?? {}).length ? (
              <Flex vertical gap={2}>
                {Object.entries(practitionerData?.printed ?? {}).map(([slot, p]) => (
                  <Typography.Text key={slot}>
                    {p.name}
                    {p.title ? `（${p.title}）` : ''}・{p.entityName}
                  </Typography.Text>
                ))}
              </Flex>
            ) : (
              '（尚未指派）'
            ),
          },
          {
            key: 'routing',
            label: '簽署序列',
            span: 2,
            // 同一人兼任時合併成一位簽署人，列出實際的簽署人（MIL-76）
            children: signerChainLabels(seats, practitionerData?.evaluation.merges ?? []).join(' → '),
          },
        ]
      : []),
    {
      key: 'signature',
      label: '簽署區',
      span: 2,
      children: (
        <SignatureChecklist fields={fields} signatureFields={sigFields} labels={labels} contractType={contractType} withDetail pages={pageMap} />
      ),
    },
  ];

  return (
    <WizardFrame
      title={`建立合約：草稿 #${shortUlid(contract.id)}`}
      current={step}
      statuses={stepStatuses(step, state)}
      wide={step === STEP_SIGNATURE}
      error={stepError}
      draft={draft}
      leave={<Link href="/contracts">先離開</Link>}
      prev={
        <Button icon={<LeftOutlined />} onClick={goPrev} disabled={step === STEP_PROPERTY || saving || sending}>
          上一步
        </Button>
      }
      next={
        step < STEP_CONFIRM ? (
          <Button type="primary" loading={saving} onClick={goNext}>
            下一步 <RightOutlined />
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={saving || sending}
            disabled={sendReasons.length > 0 || !definition.sendSupported}
            onClick={send}
          >
            確認送簽
          </Button>
        )
      }
    >
      {step === STEP_PROPERTY && (
        <ui.PropertyStep
          fields={fields}
          routingPanel={
            <RoutingConditionsPanel
              value={fields.routing ?? DEFAULT_ROUTING}
              onChange={changeRouting}
              disabled={saving}
              brokerChoice={practitionerData?.brokerChoice}
              caseDerived
            />
          }
          saving={saving}
          onFieldsChange={changeFields}
          onCommitFields={commitFields}
        />
      )}

      {step === STEP_FIELDS && (
        <ui.FieldsStep
          form={form}
          fields={fields}
          labels={labels}
          lockedPartyRoles={lockedPartyRoles}
          practitionerSlot={practitionerSlot}
          onFieldsChange={changeFields}
          onDirty={markDirty}
          mandateItems={mandateItems ?? []}
          onMandateItemsChange={(next) => {
            setMandateItems(next);
            markDirty();
          }}
        />
      )}

      {step === STEP_SIGNATURE && (
        <Row gutter={[16, 16]}>
          <Col xs={24} xl={17}>
            <Card
              size="small"
              title={partiesOnly ? '在預覽上為甲乙雙方各拖放至少一個簽名框' : '在預覽上為每個簽署席位各拖放至少一個簽名框'}
            >
              <SignatureFieldEditor
                pdfUrl={`/api/contracts/${contract.id}/pdf?v=${pdfVersion}`}
                value={sigFields}
                onChange={(next) => {
                  setSigFields(next);
                  markDirty();
                }}
                seats={seats}
                onPageMap={setPageMap}
              />
            </Card>
          </Col>
          <Col xs={24} xl={7}>
            <Card size="small" title="簽署區檢核">
              <SignatureChecklist
                fields={fields}
                signatureFields={sigFields}
                labels={labels}
                contractType={contractType}
                withDetail
                pages={pageMap}
              />
            </Card>
          </Col>
        </Row>
      )}

      {step === STEP_CONFIRM && (
        <>
          {sendReasons.length > 0 && (
            <Alert
              type="error"
              showIcon
              title="目前無法送簽，請先處理下列事項"
              description={
                <Flex vertical gap={4}>
                  {sendReasons.map((reason) => (
                    <Typography.Text key={reason}>・{reason}</Typography.Text>
                  ))}
                </Flex>
              }
            />
          )}
          <Alert
            type="info"
            showIcon
            title={signingSequenceTitle(fields, contractType, practitionerData?.evaluation.merges)}
            description={signingSequenceNotice(fields, contractType, practitionerData?.evaluation.merges)}
          />
          <ui.ConfirmNotices fields={fields} />
          {renewalNotices.map((notice) => (
            <Alert key={notice.seatRuleId} type="warning" showIcon title="換證期限將到" description={`${notice.message}。換證窗口內仍可送簽。`} />
          ))}
          <Card size="small" title="送出前摘要">
            <Descriptions column={2} size="small" bordered items={summaryItems} />
          </Card>
        </>
      )}
    </WizardFrame>
  );
}

export default function ContractWizard(props: { initial: ContractWizardInitial }) {
  return (
    <AntApp>
      <ContractWizardInner {...props} />
    </AntApp>
  );
}
