import type { BusinessType, DepositHolderRule, HolderKind, HolderRuleAction } from '../deposit-rules';
import type { OrgTx } from '../pg/with-tx';

// 讀 control.deposit_holder_rules（MIL-118，ADR-0014 決議 13）。
// 同一個 rule_id 有多個版本時只取最新版本：修法時新增新版本的列取代舊列，舊列留給持有人確認紀錄對照。

interface Row {
  rule_id: string;
  version: number;
  business_type: BusinessType | null;
  social_housing: boolean | null;
  holder_kind: HolderKind | null;
  mandate_includes_deposit: boolean | null;
  action: HolderRuleAction;
  notify_mandator: boolean;
}

const COLUMNS =
  'rule_id, version, business_type, social_housing, holder_kind, mandate_includes_deposit, action, notify_mandator';

function toRule(row: Row): DepositHolderRule {
  return {
    ruleId: row.rule_id,
    version: row.version,
    businessType: row.business_type,
    socialHousing: row.social_housing,
    holderKind: row.holder_kind,
    mandateIncludesDeposit: row.mandate_includes_deposit,
    action: row.action,
    notifyMandator: row.notify_mandator,
  };
}

/** 現行規則：每個 rule_id 取版本最大的一列。可直接傳給 evaluateHolderRule。 */
export async function loadHolderRules(tx: OrgTx): Promise<DepositHolderRule[]> {
  const { rows } = await tx.query<Row>(
    `SELECT DISTINCT ON (rule_id) ${COLUMNS} FROM control.deposit_holder_rules ORDER BY rule_id, version DESC`,
  );
  return rows.map(toRule);
}

/** 指定版本的規則列。找不到回 null。 */
export async function getHolderRule(tx: OrgTx, ruleId: string, version: number): Promise<DepositHolderRule | null> {
  const { rows } = await tx.query<Row>(
    `SELECT ${COLUMNS} FROM control.deposit_holder_rules WHERE rule_id = $1 AND version = $2`,
    [ruleId, version],
  );
  return rows[0] ? toRule(rows[0]) : null;
}
