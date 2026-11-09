'use client';

// 租賃合約的建約 wizard 畫面（MIL-73）：第①步的物件與範本、第②步的欄位表單與設備附件、
// 確認頁摘要與押金警告。從原本的 ContractWizard 搬出來，畫面與文字不變。
// 步驟、儲存、簽署區與送簽的共用流程留在 ContractWizard，不判斷合約類型。

import { useState, useEffect, type CSSProperties } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Col,
  DatePicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type {
  ContractPartyRole,
  EquipmentAnnexRow,
  EquipmentVocabularyItem,
  LeaseContractFields,
} from '@/lib/types';
import { REPAIR_RESPONSIBILITIES, REPAIR_RESPONSIBILITY_LABELS } from '@/lib/types';
import { contractEquipmentAnnex, formatEquipmentItem, newAnnexRow } from '@/lib/equipment';
import { depositWarning, type DepositWarning } from '@/lib/deposit-warning';
import {
  clauseSnapshots,
  reselectClauses,
  selectedClauseIds,
  DEFAULT_TEMPLATE,
  templateLabel,
  upgradeNotice,
} from '@/lib/clause-library';
import { extraClauseLabel, usesEquipmentAnnex } from '@/lib/contract-clauses';
import { equipmentAnnexSummary } from '@/lib/contract-detail';
import { mergeEditableFields, upgradeDraftFields } from '@/lib/contract-types';
import { TERMS } from '@/lib/labels';
import {
  STATUS_ANNEX_NOTE_MAX,
  STATUS_ANNEX_STATUSES,
  STATUS_ANNEX_STATUS_LABELS,
  STATUS_ANNEX_TITLE,
  STATUS_ANNEX_LEGAL_NAME,
  STATUS_ANNEX_VERSION,
  defaultStatusAnnex,
  statusAnnexOf,
  statusAnnexRequired,
  statusAnnexSummary,
  type StatusAnnex,
  type StatusAnnexRow,
} from '@/lib/status-annex';
import { optionalClausesFor } from '@/lib/template-registry';
import type { FieldsStepProps, PropertyStepProps, SummaryContext, WizardTypeUi } from '../types';
import { TemplateNotice } from '../TemplateNotice';

const OPTIONAL_CLAUSES = optionalClausesFor('lease');


/**
 * 選用條款勾選清單（規格 §12）：平台提供的條款逐約勾選，勾選當下就把條文快照進合約。
 * 勾選結果隨草稿保存（按「下一步」自動存），之後平台改版不動這份快照。
 */
function OptionalClauseChecklist({
  fields,
  onChange,
}: {
  fields: LeaseContractFields;
  onChange: (clauses: LeaseContractFields['clauses']) => void;
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

/**
 * 現況確認附件編輯表格（MIL-71）：固定項目清單，每列選狀態、填備註。
 * 項目清單是程式內常數（版本 v1，待法務確認），列的標籤在建立時快照進合約。
 * 有瑕疵的項目必須填備註，備註有字數上限，附件才一定放得進 PDF 的一頁。
 */
function StatusAnnexEditor({ annex, onChange }: { annex: StatusAnnex; onChange: (annex: StatusAnnex) => void }) {
  const patch = (index: number, values: Partial<StatusAnnexRow>) =>
    onChange({ ...annex, rows: annex.rows.map((row, i) => (i === index ? { ...row, ...values } : row)) });
  return (
    <Table<StatusAnnexRow>
      size="small"
      rowKey="id"
      dataSource={annex.rows}
      pagination={false}
      style={{ marginTop: 8 }}
      columns={[
        { title: '項目', dataIndex: 'label' },
        {
          title: '狀態',
          width: 130,
          render: (_, row, index) => (
            <Select
              size="small"
              style={{ width: '100%' }}
              placeholder="請選擇"
              value={row.status}
              onChange={(v) => patch(index, { status: v })}
              options={STATUS_ANNEX_STATUSES.map((status) => ({ value: status, label: STATUS_ANNEX_STATUS_LABELS[status] }))}
              aria-label={`${row.label}的狀態`}
            />
          ),
        },
        {
          title: '備註',
          width: 260,
          render: (_, row, index) => (
            <Input
              size="small"
              placeholder={row.status === 'defect' ? '必填' : '選填'}
              maxLength={STATUS_ANNEX_NOTE_MAX}
              status={row.status === 'defect' && row.note.trim() === '' ? 'error' : undefined}
              value={row.note}
              onChange={(e) => patch(index, { note: e.target.value })}
              aria-label={`${row.label}的備註`}
            />
          ),
        },
      ]}
    />
  );
}

/** 升版提示（規格 §12）：草稿綁的範本或已勾條款有新版時提示可重建，按不按由出租人決定。 */
function TemplateUpgradeNotice({
  fields,
  onUpgrade,
  disabled,
}: {
  fields: LeaseContractFields;
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

function money(value: number | null | undefined): string {
  return value == null ? '—' : `$${Number(value).toLocaleString()}`;
}

/** 押金超過 2 個月租金的警告（P0-10 規則 7）：只提醒，不擋下一步也不擋送簽。 */
function DepositWarningAlert({ warning, style }: { warning: DepositWarning | null; style?: CSSProperties }) {
  if (!warning) return null;
  return <Alert type="warning" showIcon style={style} title="押金高於 2 個月租金" description={warning.message} />;
}

/** 第①步：物件快照、分流條件（共用的 routingPanel）、範本、選用條款與升版提示。 */
function LeasePropertyStep({ fields, routingPanel, saving, onFieldsChange, onCommitFields }: PropertyStepProps<LeaseContractFields>) {
  const changeClauses = (clauses: LeaseContractFields['clauses']) => onFieldsChange({ ...fields, clauses });
  // 升版重建＝重新快照最新範本版本與已勾條款條文（v1→v2 一併把舊設備欄位轉成附件列），
  // 並立刻存檔（出租人按了才會動）
  const upgradeTemplate = () => {
    void onCommitFields(upgradeDraftFields(fields), '已升版重建，條文換成平台最新版本');
  };
  return (
    <>
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
          {routingPanel}
          <TemplateNotice contractType="lease" />
          <OptionalClauseChecklist fields={fields} onChange={changeClauses} />
          <TemplateUpgradeNotice fields={fields} onUpgrade={upgradeTemplate} disabled={saving} />
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
            物件資料在建立草稿時已帶入成快照，之後修改物件不影響這份合約。要換物件請回合約列表另建一份草稿。
            選用條款也在勾選當下快照，平台之後改版不影響這份合約。
          </Typography.Paragraph>
    </>
  );
}

/** 第②步：雙方資訊、租金與租期、其他約定事項與設備附件。 */
function LeaseFieldsStep({
  form,
  fields,
  labels,
  lockedPartyRoles,
  practitionerSlot,
  onFieldsChange,
}: FieldsStepProps<LeaseContractFields>) {
  // 現況確認附件（MIL-71）：只有簽章分流規則表要求的組合（包租租賃合約）才顯示，其他組合沒有這個區塊
  const statusAnnexShown = statusAnnexRequired(fields.routing, 'lease');
  const statusAnnex = fields.statusAnnex ?? defaultStatusAnnex();
  const changeStatusAnnex = (next: StatusAnnex) => onFieldsChange({ ...fields, statusAnnex: next });
  // 欄位步驟邊填邊判斷：表單的值還沒併回 fields 快照前，警告要跟著輸入即時更新
  const watchedRent = Form.useWatch('rent', form);
  const watchedDeposit = Form.useWatch('deposit', form);
  const fieldsStepDepositWarning = depositWarning(watchedRent, watchedDeposit);
  const partyALocked = lockedPartyRoles.includes('party_a');
  const partyBLocked = lockedPartyRoles.includes('party_b');
  // 設備附件同理：改完先放記憶體，按「下一步」時隨草稿一起存
  const changeAnnex = (equipmentAnnex: EquipmentAnnexRow[]) => onFieldsChange({ ...fields, equipmentAnnex });
  // 編輯器綁在原始快照上：名稱打到剩空字串時整列不會被正規化掉；
  // v1 舊草稿沒有這一欄，先由舊的設備欄位轉一份出來當編輯起點。
  const annexRows = fields.equipmentAnnex ?? contractEquipmentAnnex(fields);
  const annexSummary = equipmentAnnexSummary(fields);
  return (
    <>
          <Form form={form} layout="vertical" size="small" requiredMark>
            <Typography.Text strong>雙方資訊</Typography.Text>
            <Row gutter={12} style={{ marginTop: 8 }}>
              <Col span={12}>
                <Form.Item
                  name="landlordName"
                  label={`${labels.partyAFull}姓名`}
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
                  label={`${labels.partyBFull}姓名`}
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
            {practitionerSlot}

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
                清單本身另成一頁排在簽署欄之後。修繕責任預設{TERMS.lessor}。
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

          {statusAnnexShown && (
            <>
              <Typography.Text strong style={{ display: 'block', marginTop: 16 }}>
                {STATUS_ANNEX_TITLE}（{STATUS_ANNEX_LEGAL_NAME}）
              </Typography.Text>
              <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12 }}>
                包租租賃合約必附。每一項選擇狀態，有瑕疵的項目要填備註。附件另成一頁排在簽署欄之後，
                與合約同一份文件送簽，並由執業人員簽章。項目清單為第 {STATUS_ANNEX_VERSION} 版，待法務確認。
              </Typography.Paragraph>
              <StatusAnnexEditor annex={statusAnnex} onChange={changeStatusAnnex} />
            </>
          )}
    </>
  );
}

/** 確認頁：押金超過 2 個月租金的警告，放在簽署順序說明之下。 */
function LeaseConfirmNotices({ fields }: { fields: LeaseContractFields }) {
  return <DepositWarningAlert warning={depositWarning(fields.rent, fields.deposit)} style={{ marginBottom: 12 }} />;
}

/** 確認頁摘要的租賃合約部分，從物件到其他約定事項。執業人員、簽署序列與簽署區由共用流程接在後面。 */
function leaseSummaryItems(fields: LeaseContractFields, { labels }: SummaryContext) {
  const selected = clauseSnapshots(fields);
  const annexSummary = equipmentAnnexSummary(fields);
  // 確認頁都是草稿，必附時一定有內容（沒填過就是全部未填）
  const statusAnnexLines = (() => {
    const annex = statusAnnexOf('draft', 'lease', fields);
    return annex ? statusAnnexSummary(annex) : [];
  })();
  return [
    { key: 'property', label: '物件', span: 2, children: fields.propertyName || '—' },
    { key: 'address', label: '地址', span: 2, children: fields.propertyAddress || '—' },
    {
      key: 'landlord',
      label: labels.partyAFull,
      children: `${fields.landlordName}（${fields.landlordEmail}）`,
    },
    {
      key: 'tenant',
      label: labels.partyBFull,
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
    ...(statusAnnexLines.length > 0
      ? [
          {
            key: 'statusAnnex',
            label: STATUS_ANNEX_TITLE,
            span: 2,
            children: (
              <Space orientation="vertical" size={2}>
                {statusAnnexLines.map((line) => (
                  <Typography.Text key={line}>{line}</Typography.Text>
                ))}
              </Space>
            ),
          },
        ]
      : []),
    { key: 'extra', label: '其他約定事項', span: 2, children: fields.extra || '（無）' },
  ];
}

/** GET /api/contracts/[id] 載入欄位到第②步表單的值。 */
interface LeaseFormValues {
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

export const leaseWizardUi: WizardTypeUi<LeaseContractFields> = {
  PropertyStep: LeasePropertyStep,
  FieldsStep: LeaseFieldsStep,
  ConfirmNotices: LeaseConfirmNotices,
  summaryItems: leaseSummaryItems,

  formValuesOf(fields) {
    return {
      landlordName: fields.landlordName,
      landlordEmail: fields.landlordEmail,
      tenantName: fields.tenantName,
      tenantEmail: fields.tenantEmail,
      rent: fields.rent,
      deposit: fields.deposit,
      startDate: fields.startDate ? dayjs(fields.startDate) : null,
      endDate: fields.endDate ? dayjs(fields.endDate) : null,
      payDay: fields.payDay,
      extra: fields.extra,
    } satisfies LeaseFormValues;
  },

  // 把表單當下的值併回合約欄位快照（物件相關欄位在建立草稿時已帶入，不在表單編輯）
  mergeFormValues(base, values) {
    const v = values as LeaseFormValues;
    return mergeEditableFields(base, {
      ...v,
      startDate: v.startDate ? v.startDate.format('YYYY-MM-DD') : '',
      endDate: v.endDate ? v.endDate.format('YYYY-MM-DD') : '',
    });
  },

  partyFormValues(role: ContractPartyRole, person) {
    const values: Record<string, string> =
      role === 'party_a'
        ? { landlordName: person.name, landlordEmail: person.email }
        : { tenantName: person.name, tenantEmail: person.email };
    return values;
  },
};
