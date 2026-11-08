'use client';

// 建約 wizard（規格 §7）：四步分頁流程，草稿的編輯體驗一律在這裡。
// 檢核與步驟推導的純邏輯在 src/lib/contract-wizard.ts，本檔只負責蒐集輸入、呼叫 API 與畫畫面。

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Descriptions,
  Divider,
  Flex,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Spin,
  Steps,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  DeleteOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
  SendOutlined,
} from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import dayjs from 'dayjs';
import type {
  Contract,
  ContractFields,
  ContractRoutingConditions,
  EquipmentAnnexRow,
  EquipmentVocabularyItem,
  SignatureField,
} from '@/lib/types';
import { REPAIR_RESPONSIBILITIES, REPAIR_RESPONSIBILITY_LABELS, SIGNER_ROLE_LABELS } from '@/lib/types';
import { contractEquipmentAnnex, formatEquipmentItem, newAnnexRow } from '@/lib/equipment';
import { depositWarning, type DepositWarning } from '@/lib/deposit-warning';
import SignatureFieldEditor from '@/components/SignatureFieldEditor';
import RoutingConditionsPanel from '@/components/RoutingConditionsPanel';
import PractitionerAssignmentPanel, { type PartySignerPick } from '@/components/PractitionerAssignmentPanel';
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
import {
  DEFAULT_TEMPLATE,
  OPTIONAL_CLAUSES,
  clauseSnapshots,
  reselectClauses,
  selectedClauseIds,
  templateLabel,
  upgradeNotice,
} from '@/lib/clause-library';
import { extraClauseLabel, usesEquipmentAnnex } from '@/lib/contract-clauses';
import { equipmentAnnexSummary } from '@/lib/contract-detail';
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
  mergeEditableFields,
  nextStepBlockReason,
  pruneAssignments,
  resumeStepIndex,
  sendBlockReasons,
  signingSequenceNotice,
  stepStatuses,
  upgradeDraftFields,
} from '@/lib/contract-wizard';

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

/** 範本區：單範本時顯示為說明，不做選擇（ADR-0005）。 */
export function TemplateNotice() {
  return (
    <Alert
      type="info"
      showIcon
      message={`範本：${DEFAULT_TEMPLATE.name} v${DEFAULT_TEMPLATE.version}，${DEFAULT_TEMPLATE.provider}`}
      description={`${DEFAULT_TEMPLATE.note}目前平台僅一份範本，系統自動選用。`}
    />
  );
}

/**
 * 選用條款勾選清單（規格 §12）：平台提供的條款逐約勾選，勾選當下就把條文快照進合約。
 * 勾選結果隨草稿保存（按「下一步」自動存），之後平台改版不動這份快照。
 */
function OptionalClauseChecklist({
  fields,
  onChange,
}: {
  fields: ContractFields;
  onChange: (clauses: ContractFields['clauses']) => void;
}) {
  const checked = selectedClauseIds(fields);
  const toggle = (id: string, on: boolean) => {
    onChange(reselectClauses(fields, on ? [...checked, id] : checked.filter((x) => x !== id)));
  };
  return (
    <div style={{ marginTop: 12 }}>
      <Typography.Text strong>選用條款（逐約勾選，併入合約條款區）</Typography.Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        {OPTIONAL_CLAUSES.map((clause) => (
          <Checkbox
            key={clause.id}
            checked={checked.includes(clause.id)}
            onChange={(e) => toggle(clause.id, e.target.checked)}
          >
            <Typography.Text strong>{clause.title}</Typography.Text>
            <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
              {clause.body}
            </Typography.Paragraph>
          </Checkbox>
        ))}
      </div>
    </div>
  );
}

/**
 * 設備附件編輯表格（ADR-0008）：建約時由物件的設備清單帶入，之後逐約增刪列、改數量、
 * 切修繕責任、填備註，送簽時隨合約凍結為快照。可從設備詞彙庫加列。
 * 同名允許多列（例如同型冷氣分屬不同修繕責任），所以一律以列索引操作。
 */
function EquipmentAnnexEditor({
  rows,
  onChange,
}: {
  rows: EquipmentAnnexRow[];
  onChange: (rows: EquipmentAnnexRow[]) => void;
}) {
  const [vocabulary, setVocabulary] = useState<EquipmentVocabularyItem[]>([]);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/equipment-vocabulary')
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j) => setVocabulary(j.data ?? []))
      .catch(() => setVocabulary([]));
  }, []);

  const patch = (index: number, values: Partial<EquipmentAnnexRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...values } : row)));

  const addRow = () => {
    if (!picked) return;
    onChange([...rows, newAnnexRow(picked)]);
    setPicked(null);
  };

  return (
    <>
      <Table<EquipmentAnnexRow>
        size="small"
        rowKey={(_, index) => String(index)}
        dataSource={rows}
        pagination={false}
        style={{ marginTop: 8 }}
        locale={{ emptyText: '沒有設備附件列，合約條文會寫「本房屋無附屬設備」' }}
        columns={[
          {
            title: '項目',
            render: (_, row, index) => (
              <Input size="small" value={row.name} onChange={(e) => patch(index, { name: e.target.value })} />
            ),
          },
          {
            title: '數量',
            width: 90,
            render: (_, row, index) => (
              <InputNumber
                size="small"
                min={1}
                precision={0}
                style={{ width: '100%' }}
                value={row.quantity}
                onChange={(v) => patch(index, { quantity: v ?? 1 })}
              />
            ),
          },
          {
            title: '修繕責任',
            width: 110,
            render: (_, row, index) => (
              <Select
                size="small"
                style={{ width: '100%' }}
                value={row.repair}
                onChange={(v) => patch(index, { repair: v })}
                options={REPAIR_RESPONSIBILITIES.map((r) => ({
                  value: r,
                  label: REPAIR_RESPONSIBILITY_LABELS[r],
                }))}
              />
            ),
          },
          {
            title: '備註',
            render: (_, row, index) => (
              <Input
                size="small"
                placeholder="選填"
                value={row.note}
                onChange={(e) => patch(index, { note: e.target.value })}
              />
            ),
          },
          {
            title: '',
            width: 44,
            render: (_, __, index) => (
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              />
            ),
          },
        ]}
      />
      <Space.Compact style={{ marginTop: 8, width: 320 }}>
        <Select
          size="small"
          showSearch
          style={{ width: '100%' }}
          placeholder="從設備詞彙庫挑一項加列"
          value={picked}
          onChange={setPicked}
          options={vocabulary.map((v) => ({ value: v.name, label: v.name }))}
        />
        <Button size="small" icon={<PlusOutlined />} disabled={!picked} onClick={addRow}>
          加一列
        </Button>
      </Space.Compact>
    </>
  );
}

/** 升版提示（規格 §12）：草稿綁的範本或已勾條款有新版時提示可重建，按不按由房東決定。 */
function TemplateUpgradeNotice({
  fields,
  onUpgrade,
  disabled,
}: {
  fields: ContractFields;
  onUpgrade: () => void;
  disabled?: boolean;
}) {
  const notice = upgradeNotice(fields);
  if (!notice.hasUpgrade) return null;
  const parts = [
    ...(notice.template ? [`範本 v${notice.template.from} → v${notice.template.to}`] : []),
    ...notice.clauses.map((c) => `${c.title} v${c.from} → v${c.to}`),
  ];
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginTop: 12 }}
      message="平台已有新版條文，可升版重建"
      description={`${parts.join('、')}。這份草稿目前用的是建立當時的版本，升版會重新快照最新條文；不升版也能照樣送簽。`}
      action={
        <Button size="small" onClick={onUpgrade} disabled={disabled}>
          升版重建
        </Button>
      }
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
  withDetail,
}: {
  fields: ContractFields;
  signatureFields: SignatureField[];
  withDetail?: boolean;
}) {
  const evaluation = evaluateRouting(fields.routing);
  if (evaluation.ok && !isPartiesOnly(evaluation.seats)) {
    return <SeatChecklist seats={evaluation.seats} signatureFields={signatureFields} withDetail={withDetail} />;
  }
  const check = checkSignatureFields(signatureFields);
  return (
    <Space orientation="vertical" size={4}>
      <CheckLine ok={check.party_a > 0} text={`甲方（房東）簽名框 ${check.party_a} 個`} />
      <CheckLine ok={check.party_b > 0} text={`乙方（租客）簽名框 ${check.party_b} 個`} />
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

function money(value: number | null | undefined): string {
  return value == null ? '—' : `$${Number(value).toLocaleString()}`;
}

/** 押金超過 2 個月租金的警告（P0-10 規則 7）：只提醒，不擋下一步也不擋送簽。 */
function DepositWarningAlert({ warning, style }: { warning: DepositWarning | null; style?: CSSProperties }) {
  if (!warning) return null;
  return <Alert type="warning" showIcon style={style} title="押金高於 2 個月租金" description={warning.message} />;
}

/** GET /api/contracts/[id]/practitioners 的回應。 */
interface PractitionerData {
  options: SeatOptions;
  assignments: PractitionerAssignmentInput[];
  printed: Record<string, PrintedPractitioner>;
  evaluation: { ok: boolean; reasons: SendBlockReason[]; notices: SendNotice[] };
}

interface FormValues {
  landlordName?: string;
  landlordEmail?: string;
  tenantName?: string;
  tenantEmail?: string;
  rent?: number | null;
  deposit?: number | null;
  startDate?: dayjs.Dayjs | null;
  endDate?: dayjs.Dayjs | null;
  payDay?: number | null;
  extra?: string;
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
  const [form] = Form.useForm<FormValues>();
  const initialised = useRef(false);
  // 欄位步驟邊填邊判斷：表單的值還沒併回 fields 快照前，警告要跟著輸入即時更新
  const watchedRent = Form.useWatch('rent', form);
  const watchedDeposit = Form.useWatch('deposit', form);

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
      form.setFieldsValue({
        landlordName: data.fields.landlordName,
        landlordEmail: data.fields.landlordEmail,
        tenantName: data.fields.tenantName,
        tenantEmail: data.fields.tenantEmail,
        rent: data.fields.rent,
        deposit: data.fields.deposit,
        startDate: data.fields.startDate ? dayjs(data.fields.startDate) : null,
        endDate: data.fields.endDate ? dayjs(data.fields.endDate) : null,
        payDay: data.fields.payDay,
        extra: data.fields.extra,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [id, form, loadPractitioners]);

  // 把表單當下的值併回合約欄位快照（物件相關欄位在建立草稿時已帶入，不在表單編輯）。
  // 底稿一律取 fields 狀態而非載入當時的 contract.fields：不然在第①步改過的選用條款勾選，
  // 會在第②步按下一步時被載入當時的舊快照蓋掉。
  const readFields = useCallback((): ContractFields => {
    if (!fields) throw new Error('合約尚未載入');
    const v = form.getFieldsValue(true) as FormValues;
    return mergeEditableFields(fields, {
      ...v,
      startDate: v.startDate ? v.startDate.format('YYYY-MM-DD') : '',
      endDate: v.endDate ? v.endDate.format('YYYY-MM-DD') : '',
    });
  }, [fields, form]);

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
  const state = { fields, signatureFields: sigFields, assignments: practitionerData ? assignments : undefined };
  const routingEvaluation = evaluateRouting(fields.routing);
  const seats = routingEvaluation.ok ? routingEvaluation.seats : undefined;
  const partiesOnly = !seats || isPartiesOnly(seats);
  // 有執業人員的簽署序列才在確認頁列出擋下原因並停用送簽；兩方序列沿用原本的行為（送簽時才提示）
  // 伺服器的送簽前檢查（資格、專任、Email 重複等）接在後面，同一句不重複列
  const serverReasons = practitionerData?.evaluation.reasons.map((r) => r.message) ?? [];
  const sendReasons = partiesOnly ? [] : [...new Set([...sendBlockReasons(state), ...serverReasons])];
  const renewalNotices = practitionerData?.evaluation.notices ?? [];
  const lockedPartyRoles = routingEvaluation.ok ? entityPartyRoles(routingEvaluation.plan) : [];
  const partyALocked = lockedPartyRoles.includes('party_a');
  const partyBLocked = lockedPartyRoles.includes('party_b');

  const fieldsStepDepositWarning = depositWarning(watchedRent, watchedDeposit);
  const confirmDepositWarning = depositWarning(fields.rent, fields.deposit);

  const goNext = async () => {
    const nextFields = step === STEP_FIELDS ? readFields() : fields;
    const blocked = nextStepBlockReason(step, { fields: nextFields, signatureFields: sigFields, assignments });
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

  // 勾選變動只改記憶體裡的草稿；跟其他欄位一樣按「下一步」時才一併存回
  const changeClauses = (clauses: ContractFields['clauses']) => setFields({ ...fields, clauses });

  // 設備附件同理：改完先放記憶體，按「下一步」時隨草稿一起存
  const changeAnnex = (equipmentAnnex: EquipmentAnnexRow[]) => setFields({ ...fields, equipmentAnnex });

  // 升版重建＝重新快照最新範本版本與已勾條款條文（v1→v2 一併把舊設備欄位轉成附件列），
  // 並立刻存檔（房東按了才會動）
  const upgradeTemplate = async () => {
    const next = upgradeDraftFields(fields);
    setFields(next);
    if (await saveDraft(next, sigFields)) message.success('已升版重建，條文換成平台最新版本');
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
    setFields((current) => (current ? applyPartySigner(current, role, person) : current));
    form.setFieldsValue(
      role === 'party_a'
        ? { landlordName: person.name, landlordEmail: person.email }
        : { tenantName: person.name, tenantEmail: person.email }
    );
  };

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

  const selected = clauseSnapshots(fields);
  // 編輯器綁在原始快照上：名稱打到剩空字串時整列不會被正規化掉；
  // v1 舊草稿沒有這一欄，先由舊的設備欄位轉一份出來當編輯起點。
  const annexRows = fields.equipmentAnnex ?? contractEquipmentAnnex(fields);
  const annexSummary = equipmentAnnexSummary(fields);
  const summaryItems = [
    { key: 'property', label: '物件', span: 2, children: fields.propertyName || '—' },
    { key: 'address', label: '地址', span: 2, children: fields.propertyAddress || '—' },
    {
      key: 'landlord',
      label: '甲方（房東）',
      children: `${fields.landlordName}（${fields.landlordEmail}）`,
    },
    {
      key: 'tenant',
      label: '乙方（租客）',
      children: `${fields.tenantName}（${fields.tenantEmail}）`,
    },
    { key: 'rent', label: '月租金', children: money(fields.rent) },
    { key: 'deposit', label: '押金', children: money(fields.deposit) },
    { key: 'lease', label: '租期', children: `${fields.startDate} ~ ${fields.endDate}` },
    { key: 'payDay', label: '每月付款日', children: fields.payDay != null ? `${fields.payDay} 日` : '—' },
    { key: 'template', label: '範本', span: 2, children: `${templateLabel(fields)}（${DEFAULT_TEMPLATE.provider}）` },
    {
      key: 'clauses',
      label: '選用條款',
      span: 2,
      children: selected.length ? (
        <Space size={4} wrap>
          {selected.map((clause) => (
            <Tag key={clause.id} color="blue">
              {clause.title} v{clause.version}
            </Tag>
          ))}
        </Space>
      ) : (
        '（未勾選）'
      ),
    },
    {
      key: 'equipmentAnnex',
      label: '設備附件',
      span: 2,
      children: annexSummary.length ? (
        <Space orientation="vertical" size={2}>
          {annexSummary.map((line) => (
            <Typography.Text key={line}>{line}</Typography.Text>
          ))}
        </Space>
      ) : (
        '（無附屬設備）'
      ),
    },
    { key: 'extra', label: '其他約定事項', span: 2, children: fields.extra || '（無）' },
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
      children: <SignatureChecklist fields={fields} signatureFields={sigFields} withDetail />,
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
          <Descriptions
            column={1}
            size="small"
            style={{ marginBottom: 12 }}
            items={[
              { key: 'name', label: '物件', children: fields.propertyName || '—' },
              { key: 'address', label: '地址', children: fields.propertyAddress || '—' },
              { key: 'type', label: '型態', children: fields.propertyType || '—' },
              {
                key: 'size',
                label: '坪數',
                children: fields.propertySize != null ? `${fields.propertySize} 坪` : '—',
              },
              {
                key: 'equipment',
                label: '附屬設備',
                children: (() => {
                  const items = contractEquipmentAnnex(fields);
                  return items.length ? items.map(formatEquipmentItem).join('、') : '—';
                })(),
              },
            ]}
          />
          <Flex vertical gap={12} style={{ marginBottom: 12 }}>
            <RoutingConditionsPanel value={fields.routing ?? DEFAULT_ROUTING} onChange={changeRouting} disabled={saving} />
          </Flex>
          <TemplateNotice />
          <OptionalClauseChecklist fields={fields} onChange={changeClauses} />
          <TemplateUpgradeNotice fields={fields} onUpgrade={upgradeTemplate} disabled={saving} />
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
            物件資料在建立草稿時已帶入成快照，之後修改物件不影響這份合約。要換物件請回合約列表另建一份草稿。
            選用條款也在勾選當下快照，平台之後改版不影響這份合約。
          </Typography.Paragraph>
        </Card>
      )}

      {step === STEP_FIELDS && (
        <Card size="small" style={{ maxWidth: 760 }}>
          <Form form={form} layout="vertical" size="small" requiredMark>
            <Typography.Text strong>雙方資訊</Typography.Text>
            <Row gutter={12} style={{ marginTop: 8 }}>
              <Col span={12}>
                <Form.Item
                  name="landlordName"
                  label="甲方（房東）姓名"
                  rules={partyALocked ? [] : [{ required: true, message: '請輸入甲方姓名' }]}
                >
                  <Input disabled={partyALocked} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="landlordEmail"
                  label="甲方 Email"
                  rules={
                    partyALocked
                      ? []
                      : [{ required: true, type: 'email', message: '請輸入有效的甲方 Email' }]
                  }
                >
                  <Input disabled={partyALocked} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="tenantName"
                  label="乙方（租客）姓名"
                  rules={partyBLocked ? [] : [{ required: true, message: '請輸入乙方姓名' }]}
                >
                  <Input disabled={partyBLocked} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="tenantEmail"
                  label="乙方 Email"
                  rules={
                    partyBLocked
                      ? []
                      : [{ required: true, type: 'email', message: '請輸入有效的乙方 Email' }]
                  }
                >
                  <Input disabled={partyBLocked} />
                </Form.Item>
              </Col>
            </Row>
            {!partiesOnly && (
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
            )}

            <Typography.Text strong>租金與租期</Typography.Text>
            <Row gutter={12} style={{ marginTop: 8 }}>
              <Col span={12}>
                <Form.Item name="rent" label="月租金（元）" rules={[{ required: true, message: '請輸入月租金' }]}>
                  <InputNumber min={0} step={1000} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="deposit" label="押金（元）">
                  <InputNumber min={0} step={1000} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              {fieldsStepDepositWarning && (
                <Col span={24}>
                  <Form.Item>
                    <DepositWarningAlert warning={fieldsStepDepositWarning} />
                  </Form.Item>
                </Col>
              )}
              <Col span={8}>
                <Form.Item name="startDate" label="租期起日" rules={[{ required: true, message: '請選擇租期起日' }]}>
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="endDate" label="租期迄日" rules={[{ required: true, message: '請選擇租期迄日' }]}>
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="payDay" label="每月付款日">
                  <InputNumber min={1} max={28} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item
              name="extra"
              label={`其他約定事項（${extraClauseLabel(fields)}）`}
              style={{ marginBottom: 0 }}
            >
              <Input.TextArea rows={3} placeholder="無則留空" />
            </Form.Item>
          </Form>

          <Typography.Text strong style={{ display: 'block', marginTop: 16 }}>
            設備附件（附屬設備清單）
          </Typography.Text>
          {usesEquipmentAnnex(fields) ? (
            <>
              <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12 }}>
                由物件的設備清單帶入，可逐約增刪列、調整數量與修繕責任；產出的合約以「詳如附件」引用這張清單，
                清單本身另成一頁排在簽署欄之後。修繕責任預設出租方。
              </Typography.Paragraph>
              <EquipmentAnnexEditor rows={annexRows} onChange={changeAnnex} />
            </>
          ) : (
            // v1 草稿的附屬設備仍寫在主約本文（ADR-0005 不回溯）：這裡只唸不編，升版後才開放附件編輯
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 8 }}
              message="此草稿綁定範本 v1，附屬設備列在主約本文，不產出附件頁"
              description={
                annexSummary.length
                  ? `目前品項：${annexSummary.join('、')}。升版為 v2 後，才能逐約編輯設備附件。`
                  : '目前沒有附屬設備。升版為 v2 後，才能逐約編輯設備附件。'
              }
            />
          )}
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
              <SignatureChecklist fields={fields} signatureFields={sigFields} withDetail />
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
            description={signingSequenceNotice(fields)}
          />
          <DepositWarningAlert warning={confirmDepositWarning} style={{ marginBottom: 12 }} />
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
