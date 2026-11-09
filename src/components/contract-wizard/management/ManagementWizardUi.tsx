'use client';

// 委託管理合約的建約 wizard 畫面（MIL-74）：第①步的範本說明、第②步的當事人、委託期間、報酬約定與委託標的清單、
// 確認頁摘要。步驟、儲存、執業人員指派、簽署區與送簽的共用流程在 ContractWizard，不判斷合約類型。
// 受託人是執業主體：乙方的姓名與 Email 由共用流程的指派區帶入，這裡鎖住不開放手填（ADR-0018 決議 2）。
// 送簽屬 MIL-77，確認頁說明目前只到草稿與 PDF 預覽。

import { Alert, Col, DatePicker, Descriptions, Flex, Form, Input, InputNumber, Row, Select, Space, Typography } from 'antd';
import dayjs from 'dayjs';
import { contractTypeDefinition, mergeManagementFields } from '@/lib/contract-types';
import { TERMS } from '@/lib/labels';
import { mandateScopeText } from '@/lib/mandate-schedule';
import { buildManagementClauses, feeText, termText } from '@/lib/management-clauses';
import {
  MANAGEMENT_FEE_MODES,
  MANAGEMENT_FEE_MODE_LABELS,
  type ContractPartyRole,
  type ManagementContractFields,
  type ManagementFeeMode,
} from '@/lib/types';
import type { FieldsStepProps, SummaryContext, WizardTypeUi } from '../types';
import { TemplateNotice } from '../TemplateNotice';
import MandateItemsEditor from './MandateItemsEditor';

/** 第①步：委託管理合約沒有物件與分流條件要填，只說明範本與租賃單位的加入方式。 */
function ManagementPropertyStep() {
  return (
    <Flex vertical gap={12}>
      <Alert
        type="info"
        showIcon
        title={contractTypeDefinition('management').draftNotice?.title}
        description={contractTypeDefinition('management').draftNotice?.description}
      />
      <TemplateNotice contractType="management" />
    </Flex>
  );
}

const FEE_UNIT: Record<ManagementFeeMode, string> = { monthly_fixed: '元', rent_percentage: '%' };

/** 第②步：當事人、受託人的執業主體與專任管理人員（共用指派區）、委託期間、報酬約定、其他約定與委託標的清單。 */
function ManagementFieldsStep({
  form,
  labels,
  lockedPartyRoles,
  practitionerSlot,
  mandateItems,
  onMandateItemsChange,
}: FieldsStepProps<ManagementContractFields>) {
  const feeMode = Form.useWatch('feeMode', form) as ManagementFeeMode | undefined;
  const mandataryLocked = lockedPartyRoles.includes('party_b');
  return (
    <>
      <Form form={form} layout="vertical" size="small" requiredMark>
        <Typography.Text strong>雙方資訊</Typography.Text>
        <Row gutter={12} style={{ marginTop: 8 }}>
          <Col span={12}>
            <Form.Item
              name="mandatorName"
              label={`${labels.partyAFull}姓名`}
              rules={[{ required: true, message: `請輸入${TERMS.mandator}姓名` }]}
            >
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="mandatorEmail"
              label={`${TERMS.mandator} Email`}
              rules={[{ required: true, type: 'email', message: `請輸入有效的${TERMS.mandator} Email` }]}
            >
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="mandataryName"
              label={`${labels.partyBFull}姓名`}
              rules={mandataryLocked ? [] : [{ required: true, message: `請輸入${TERMS.mandatary}姓名` }]}
            >
              <Input disabled={mandataryLocked} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="mandataryEmail"
              label={`${TERMS.mandatary} Email`}
              rules={
                mandataryLocked ? [] : [{ required: true, type: 'email', message: `請輸入有效的${TERMS.mandatary} Email` }]
              }
            >
              <Input disabled={mandataryLocked} />
            </Form.Item>
          </Col>
        </Row>
        {practitionerSlot}

        <Typography.Text strong>委託期間與報酬約定</Typography.Text>
        <Row gutter={12} style={{ marginTop: 8 }}>
          <Col span={12}>
            <Form.Item name="termStart" label="委託期間起日" rules={[{ required: true, message: '請選擇委託期間起日' }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="termEnd" label="委託期間迄日" rules={[{ required: true, message: '請選擇委託期間迄日' }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="feeMode" label="報酬約定" rules={[{ required: true, message: '請選擇報酬約定的形式' }]}>
              <Select
                placeholder="選擇報酬約定的形式"
                options={MANAGEMENT_FEE_MODES.map((mode) => ({ value: mode, label: MANAGEMENT_FEE_MODE_LABELS[mode] }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="feeValue" label="報酬金額" rules={[{ required: true, message: '請輸入報酬金額' }]}>
              <InputNumber
                min={0}
                max={feeMode === 'rent_percentage' ? 100 : undefined}
                step={feeMode === 'rent_percentage' ? 1 : 500}
                style={{ width: '100%' }}
                suffix={feeMode ? FEE_UNIT[feeMode] : undefined}
                disabled={!feeMode}
              />
            </Form.Item>
          </Col>
        </Row>
      </Form>

      <div style={{ marginTop: 16 }}>
        <MandateItemsEditor items={mandateItems} onChange={onMandateItemsChange} />
      </div>
    </>
  );
}

/** 確認頁：說明目前只到草稿與 PDF 預覽。送簽屬 MIL-77。 */
function ManagementConfirmNotices() {
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      title="委託管理合約尚未開放送簽"
      description="目前可以確認內容並預覽 PDF，草稿會保留。送簽功能開放後，再回到這份草稿送簽。"
    />
  );
}

/** 確認頁摘要的委託管理合約部分。執業人員、簽署序列與簽署區由共用流程接在後面。 */
function managementSummaryItems(fields: ManagementContractFields, { labels, contractId, mandateItems }: SummaryContext) {
  return [
    { key: 'mandator', label: labels.partyAFull, children: `${fields.mandatorName}（${fields.mandatorEmail}）` },
    { key: 'mandatary', label: labels.partyBFull, children: `${fields.mandataryName}（${fields.mandataryEmail}）` },
    { key: 'term', label: '委託期間', span: 2, children: termText(fields) },
    { key: 'fee', label: '報酬約定', span: 2, children: feeText(fields) },
    {
      key: 'mandate',
      label: '委託標的',
      span: 2,
      children: mandateItems.length ? (
        <Space orientation="vertical" size={2}>
          {mandateItems.map((item) => (
            <Typography.Text key={item.propertyId}>
              {item.propertyName}：{mandateScopeText(item.scopes)}
            </Typography.Text>
          ))}
        </Space>
      ) : (
        '（尚未加入租賃單位）'
      ),
    },
    {
      key: 'clauses',
      label: '條文',
      span: 2,
      children: `${buildManagementClauses(fields).length} 條，平台提供的簡化示意條文`,
    },
    {
      key: 'pdf',
      label: 'PDF 預覽',
      span: 2,
      children: (
        <Typography.Link href={`/api/contracts/${contractId}/pdf`} target="_blank" rel="noreferrer">
          開啟委託管理契約書 PDF
        </Typography.Link>
      ),
    },
  ] satisfies NonNullable<React.ComponentProps<typeof Descriptions>['items']>;
}

interface ManagementFormValues {
  mandatorName?: string;
  mandatorEmail?: string;
  mandataryName?: string;
  mandataryEmail?: string;
  termStart?: dayjs.Dayjs | null;
  termEnd?: dayjs.Dayjs | null;
  feeMode?: ManagementFeeMode | null;
  feeValue?: number | null;
}

export const managementWizardUi: WizardTypeUi<ManagementContractFields> = {
  hasMandateItems: true,
  PropertyStep: ManagementPropertyStep,
  FieldsStep: ManagementFieldsStep,
  ConfirmNotices: ManagementConfirmNotices,
  summaryItems: managementSummaryItems,

  formValuesOf(fields) {
    return {
      mandatorName: fields.mandatorName,
      mandatorEmail: fields.mandatorEmail,
      mandataryName: fields.mandataryName,
      mandataryEmail: fields.mandataryEmail,
      termStart: fields.termStart ? dayjs(fields.termStart) : null,
      termEnd: fields.termEnd ? dayjs(fields.termEnd) : null,
      feeMode: fields.feeMode,
      feeValue: fields.feeValue,
    } satisfies ManagementFormValues;
  },

  mergeFormValues(base, values) {
    const v = values as ManagementFormValues;
    return mergeManagementFields(base, {
      ...v,
      termStart: v.termStart ? v.termStart.format('YYYY-MM-DD') : '',
      termEnd: v.termEnd ? v.termEnd.format('YYYY-MM-DD') : '',
    });
  },

  partyFormValues(role: ContractPartyRole, person) {
    const values: Record<string, string> =
      role === 'party_a'
        ? { mandatorName: person.name, mandatorEmail: person.email }
        : { mandataryName: person.name, mandataryEmail: person.email };
    return values;
  },
};
