'use client';

// 分流條件（ADR-0021 決議 1）：建約 wizard 第一步填業務類型、承租人是否為包租業者、是否有經紀業者居間。
// 系統依條件算出簽署序列並顯示；規則未定義的組合顯示原因，由呼叫端擋下一步。
// 排序與擋下的判斷都在 src/lib/signature-routing/，這裡只畫畫面。

import { Alert, Col, Flex, Form, Radio, Row, Tag, Typography } from 'antd';
import styles from '@/components/contract-wizard/steps.module.css';
import { RightOutlined } from '@ant-design/icons';
import { BUSINESS_TYPES } from '@/lib/cases';
import { BUSINESS_TYPE_LABELS } from '@/lib/labels';
import type { BrokerChoice } from '@/lib/practitioner-assignment/broker-choice';
import { evaluateRouting, hasPractitionerSeat } from '@/lib/signature-routing';
import type { ContractRoutingConditions } from '@/lib/types';

interface Props {
  value: ContractRoutingConditions;
  onChange: (next: ContractRoutingConditions) => void;
  disabled?: boolean;
  /** 業務類型與「承租人是否為包租業者」由案件種類決定（MIL-209）。為 true 時這兩項只顯示，不給選。 */
  caseDerived?: boolean;
  /**
   * 居間選項的狀態（MIL-200）。由伺服端依呼叫者自己組織的經紀業別算出：
   * 屋主組織與沒有經紀業別的組織是 hidden，登錄了但還沒驗證是 blocked 並附原因，已驗證是 allowed。
   * 還沒載入時視為 hidden。合約已經勾了居間時，選項仍顯示但不能改，既有合約的條件不回寫。
   */
  brokerChoice?: BrokerChoice;
}

const YES_NO = [
  { value: true, label: '是' },
  { value: false, label: '否' },
];

export default function RoutingConditionsPanel({
  value,
  onChange,
  disabled,
  caseDerived,
  brokerChoice = { kind: 'hidden' },
}: Props) {
  const evaluation = evaluateRouting(value);
  const patch = (next: Partial<ContractRoutingConditions>) => onChange({ ...value, ...next });
  const showBroker = brokerChoice.kind !== 'hidden' || value.brokerMediated;
  const brokerLocked = brokerChoice.kind !== 'allowed';
  const brokerSpan = showBroker ? 8 : 12;

  return (
    <Flex vertical gap={12}>
      <Typography.Text strong>分流條件（決定誰要簽署與簽署順序）</Typography.Text>
      <Form layout="vertical" size="small">
        <Row gutter={12}>
          <Col span={8}>
            <Form.Item label="業務類型" className={styles.flush}>
              <Radio.Group
                disabled={disabled || caseDerived}
                value={value.businessType}
                onChange={(e) => patch({ businessType: e.target.value })}
                options={BUSINESS_TYPES.map((type) => ({ value: type, label: BUSINESS_TYPE_LABELS[type] }))}
              />
            </Form.Item>
          </Col>
          <Col span={brokerSpan}>
            <Form.Item label="承租人是否為包租業者" className={styles.flush}>
              <Radio.Group
                disabled={disabled || caseDerived}
                value={value.lesseeIsMasterLessor}
                onChange={(e) => patch({ lesseeIsMasterLessor: e.target.value })}
                options={YES_NO}
              />
            </Form.Item>
          </Col>
          {showBroker && (
            <Col span={8}>
              <Form.Item
                label="是否有經紀業者居間"
                className={styles.flush}
                extra={brokerChoice.kind === 'blocked' ? brokerChoice.reason : undefined}
              >
                <Radio.Group
                  disabled={disabled || brokerLocked}
                  value={value.brokerMediated}
                  onChange={(e) => patch({ brokerMediated: e.target.value })}
                  options={YES_NO}
                />
              </Form.Item>
            </Col>
          )}
        </Row>
      </Form>

      {evaluation.ok ? (
        <>
          <Flex vertical gap={8}>
            <Typography.Text type="secondary">簽署序列</Typography.Text>
            <Flex wrap align="center" gap={8} aria-label="簽署序列">
              {evaluation.seats.map((seat, index) => (
                <Flex key={seat.ruleId} align="center" gap={8}>
                  {index > 0 && (
                    <Typography.Text type="secondary" aria-hidden>
                      <RightOutlined />
                    </Typography.Text>
                  )}
                  <Tag className={styles.tag}>
                    {index + 1}　{seat.fullLabel}
                  </Tag>
                </Flex>
              ))}
            </Flex>
          </Flex>
          {hasPractitionerSeat(evaluation.seats) && (
            <Alert
              type="warning"
              showIcon
              title="這個組合需要執業人員簽章"
              description="合約上會多一個執業人員的簽署欄，簽署區域也要為他設定。下一步填寫欄位時，要從平台登錄選擇執業主體與執業人員。"
            />
          )}
        </>
      ) : (
        <Alert type="error" showIcon title="這個分流條件無法繼續" description={evaluation.reason} />
      )}
    </Flex>
  );
}
