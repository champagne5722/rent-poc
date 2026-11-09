'use client';

// 執業人員的指派欄位（MIL-69）：包租業者在建約 wizard 選專任管理人員與當事人簽署人。
// 人選一律來自平台登錄（practiceRegistry），不開放手動輸入；執業人員的 Email 取自其帳號，畫面不能修改（ADR-0018 決議 10 第 6 項）。
// 候選清單只列目前可簽章的人。證書在換證窗口內仍可選，並顯示換證期限（ADR-0017 決議 8）。
// 資格的判定與送簽前檢查在 src/lib/practitioner-assignment/ 與 src/lib/send-preconditions/，這裡只畫畫面。

import { Alert, Col, Flex, Form, Input, Row, Select, Skeleton, Typography } from 'antd';
import type { SeatOption, SeatOptions } from '@/lib/practitioner-assignment/service';
import type { MergedSeats } from '@/lib/signature-routing';
import type { PractitionerAssignmentInput } from '@/lib/practitioner-assignment/seats';
import { SIGNER_ROLE_LABELS, type ContractPartyRole } from '@/lib/types';

/** 同一人兼任而合併的席位（送簽前評估的 merges），附兼任者的姓名給畫面提示。 */
export type MergedSeatNotice = MergedSeats & { name: string };

export interface PartySignerPick {
  role: ContractPartyRole;
  /** null 代表清空（改選執業主體後，舊簽署人不再適用）。 */
  signer: { name: string; email: string } | null;
}

interface Props {
  options: SeatOptions | null;
  /** 草稿中的選擇，可能還沒選完。 */
  assignments: readonly PractitionerAssignmentInput[];
  onChange: (next: PractitionerAssignmentInput[]) => void;
  /** 選定或清空當事人簽署人時，呼叫端把姓名與 Email 帶入合約欄位。 */
  onPartySigner: (pick: PartySignerPick) => void;
  /** 合併的席位。送簽時這位簽署人只簽一次。 */
  merges?: readonly MergedSeatNotice[];
  disabled?: boolean;
}

function replaceSlot(
  list: readonly PractitionerAssignmentInput[],
  slot: string,
  next: PractitionerAssignmentInput,
): PractitionerAssignmentInput[] {
  return [...list.filter((a) => a.slot !== slot), next];
}

function SeatAssignment({
  seat,
  current,
  onAssign,
  onPartySigner,
  merged,
  disabled,
}: {
  seat: SeatOption;
  current: PractitionerAssignmentInput | undefined;
  onAssign: (next: PractitionerAssignmentInput) => void;
  onPartySigner: (pick: PartySignerPick) => void;
  merged?: MergedSeatNotice;
  disabled?: boolean;
}) {
  const entity = seat.entities.find((e) => e.id === current?.entityId);
  const blockedEntities = seat.entities.filter((e) => e.blockedReason);
  const practitioner = entity?.practitioners.find((p) => p.id === current?.practitionerId);
  const blank = (entityId: string): PractitionerAssignmentInput => ({
    slot: seat.ruleId,
    entityId,
    practitionerId: '',
    partySignerId: null,
  });

  const pickEntity = (entityId: string) => {
    onAssign(blank(entityId));
    if (seat.partyRole) onPartySigner({ role: seat.partyRole, signer: null });
  };
  const pickPartySigner = (partySignerId: string) => {
    const signer = entity?.partySigners.find((s) => s.id === partySignerId);
    if (!current || !signer || !seat.partyRole) return;
    onAssign({ ...current, partySignerId });
    onPartySigner({ role: seat.partyRole, signer: { name: signer.name, email: signer.email } });
  };
  const pickPractitioner = (practitionerId: string) => {
    if (current) onAssign({ ...current, practitionerId });
  };

  return (
    <Flex vertical gap={8}>
      <Typography.Text strong>{seat.label}</Typography.Text>
      <Row gutter={[12, 12]}>
        <Col span={12}>
          <Form.Item label="執業主體" style={{ marginBottom: 0 }}>
            <Select
              disabled={disabled}
              placeholder="選擇執業主體"
              value={current?.entityId}
              onChange={pickEntity}
              options={seat.entities.map((e) => ({
                value: e.id,
                label: e.blockedReason ? `${e.name}（不能選）` : e.name,
                disabled: !!e.blockedReason,
              }))}
            />
          </Form.Item>
        </Col>
        {seat.partyRole && (
          <Col span={12}>
            <Form.Item label={`${SIGNER_ROLE_LABELS[seat.partyRole]}的當事人簽署人`} style={{ marginBottom: 0 }}>
              <Select
                disabled={disabled || !entity}
                placeholder={entity ? '選擇當事人簽署人' : '請先選擇執業主體'}
                value={current?.partySignerId ?? undefined}
                onChange={pickPartySigner}
                options={(entity?.partySigners ?? []).map((s) => ({ value: s.id, label: `${s.name}（${s.email}）` }))}
              />
            </Form.Item>
          </Col>
        )}
        <Col span={12}>
          <Form.Item label="執業人員" style={{ marginBottom: 0 }}>
            <Select
              disabled={disabled || !entity}
              placeholder={entity ? '選擇執業人員' : '請先選擇執業主體'}
              value={current?.practitionerId || undefined}
              onChange={pickPractitioner}
              options={(entity?.practitioners ?? []).map((p) => ({
                value: p.id,
                label: [p.name, p.title ? `（${p.title}）` : '', p.renewalWindow ? `・換證期限 ${p.renewalWindow.validUntil}` : ''].join(''),
              }))}
            />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item label="執業人員 Email（取自帳號，不能修改）" style={{ marginBottom: 0 }}>
            <Input readOnly variant="filled" value={practitioner?.email ?? ''} placeholder="選定執業人員後帶入" />
          </Form.Item>
        </Col>
      </Row>
      {blockedEntities.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title="下列執業主體不能選"
          description={
            <Flex vertical>
              {blockedEntities.map((e) => (
                <Typography.Text key={e.id}>
                  {e.name}：{e.blockedReason}
                </Typography.Text>
              ))}
            </Flex>
          }
        />
      )}
      {seat.notice && <Typography.Text type="secondary">{seat.notice}</Typography.Text>}
      {merged && (
        <Alert
          type="info"
          showIcon
          title={`${merged.name}同時是${SIGNER_ROLE_LABELS[merged.partyRole]}的當事人簽署人與${SIGNER_ROLE_LABELS.practitioner}`}
          description="送簽時合併為一位簽署人，只簽一次，兩個角色的簽名框都由這位簽署。簽章紀錄會標示兼任角色，合約歷程也會記下。"
        />
      )}
      {practitioner?.renewalWindow && (
        <Alert
          type="warning"
          showIcon
          title={`${practitioner.name}的證書將於 ${practitioner.renewalWindow.validUntil} 期滿`}
          description="換證窗口內仍可送簽。請於期滿前換證，期滿後這位執業人員就不能簽章。"
        />
      )}
      {entity && entity.practitioners.length === 0 && (
        <Alert
          type="info"
          showIcon
          title="這個執業主體目前沒有可簽章的執業人員"
          description="候選清單只列業別、證書與任職都已驗證，且符合專任要求的人。"
        />
      )}
    </Flex>
  );
}

export default function PractitionerAssignmentPanel({ options, assignments, onChange, onPartySigner, merges = [], disabled }: Props) {
  if (!options) return <Skeleton active paragraph={{ rows: 3 }} title={false} />;
  if (!options.available) {
    return <Alert type="error" showIcon title="目前無法指派執業人員" description={options.reason} />;
  }
  if (options.seats.length === 0) return null;

  return (
    <Flex vertical gap={12}>
      <Typography.Text strong>執業人員簽章</Typography.Text>
      <Typography.Text type="secondary">
        依簽署序列，這份合約需要執業人員簽章。人選來自平台登錄，只列目前可簽章的人。
      </Typography.Text>
      {options.registryKind === 'seed' && (
        <Alert
          type="info"
          showIcon
          title="目前的人選是示範用假資料"
          description="只用於 mock 與 sandbox。正式環境接上真實的登錄資料之前，要求執業人員簽章的合約無法送簽。"
        />
      )}
      {options.seats.map((seat) => (
        <SeatAssignment
          key={seat.ruleId}
          seat={seat}
          current={assignments.find((a) => a.slot === seat.ruleId)}
          onAssign={(next) => onChange(replaceSlot(assignments, seat.ruleId, next))}
          onPartySigner={onPartySigner}
          merged={merges.find((m) => m.practitionerRuleId === seat.ruleId)}
          disabled={disabled}
        />
      ))}
    </Flex>
  );
}
