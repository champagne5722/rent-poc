// 合約詳情頁「簽章紀錄」區塊的資料整理（MIL-70）。純函式，client 與 server 都能引用。
// 這個區塊唯讀：簽章紀錄寫入後不會修改，畫面只呈現不提供任何編輯入口。

import { practitionerTitle } from '../labels';
import type { CredentialState } from '../registry-rules';
import { SIGNER_ROLE_LABELS } from '../types';
import { isUnavailableSnapshot, type CredentialSnapshot, type SignatureSnapshot } from './snapshot';
import type { SignatureRecordDetail } from './types';

export interface SignatureRecordCard {
  /** 席位的 rule_id。 */
  key: string;
  title: string;
  summary: Array<{ label: string; value: string }>;
  /** 送簽時與簽署時的證書快照並排。 */
  snapshotRows: Array<{ key: string; label: string; atSend: string; atSign: string }>;
}

const EMPTY = '—';
const NOT_YET_SIGNED = '尚未簽署';

const STATE_TEXT: Record<CredentialState | 'none', string> = {
  none: '尚未登錄',
  pending: '待驗證',
  verified: '已驗證',
  lapsed: '已失效',
};

/** ISO 8601 換成台灣時間，到分。不是有效時間時原樣回傳。 */
export function formatTaiwanTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function stateText(state: CredentialState | null): string {
  return STATE_TEXT[state ?? 'none'];
}

function layerText(state: CredentialState | null, checkId: string | null): string {
  return checkId ? `${stateText(state)}，核對紀錄 ${checkId}` : stateText(state);
}

function resultText(snapshot: CredentialSnapshot): string {
  const { result } = snapshot;
  if (!result.signable) return `不可簽章：${result.issues.map((i) => i.message).join('、')}`;
  return result.renewalWindow
    ? `可簽章，換證窗口內，證書 ${result.renewalWindow.validUntil} 期滿`
    : '可簽章';
}

type Row = { key: string; label: string; value: (s: CredentialSnapshot) => string };

const SNAPSHOT_ROWS: Row[] = [
  { key: 'decidedAt', label: '判定時點', value: (s) => formatTaiwanTime(s.decidedAt) },
  { key: 'result', label: '判定結果', value: resultText },
  { key: 'certificateKind', label: '證書種類', value: (s) => (s.certificateKind ? practitionerTitle(s.certificateKind) : EMPTY) },
  { key: 'certificateNo', label: '證書號碼', value: (s) => s.certificateNoMasked ?? EMPTY },
  { key: 'validUntil', label: '證書效期', value: (s) => s.validUntil ?? EMPTY },
  { key: 'license', label: '業別', value: (s) => layerText(s.layers.license.state, s.layers.license.latestCheckId) },
  { key: 'practitioner', label: '證書', value: (s) => layerText(s.layers.practitioner.state, s.layers.practitioner.latestCheckId) },
  { key: 'employment', label: '任職', value: (s) => layerText(s.layers.employment.state, s.layers.employment.latestCheckId) },
  {
    key: 'employmentPeriod',
    label: '任職期間',
    value: (s) => `${s.layers.employment.startsOn} ${s.layers.employment.endsOn ? `至 ${s.layers.employment.endsOn}` : '起'}`,
  },
];

function signCell(row: Row, detail: SignatureRecordDetail): string {
  const sign: SignatureSnapshot | null = detail.snapshotAtSign;
  if (!sign) {
    // 還沒有簽署時快照：只在第一列說明，其餘列留空白，避免整欄重複同一句
    if (row.key !== 'decidedAt') return EMPTY;
    return detail.signer.status === 'declined' ? '未簽署，沒有簽署時快照' : NOT_YET_SIGNED;
  }
  if (isUnavailableSnapshot(sign)) {
    if (row.key === 'decidedAt') return formatTaiwanTime(sign.decidedAt);
    if (row.key === 'result') return `未取得登錄資料：${sign.reason}`;
    return EMPTY;
  }
  return row.value(sign);
}

function signStatusText(detail: SignatureRecordDetail): string {
  const { status, signedAt } = detail.signer;
  if (status === 'declined') return '已拒簽';
  if (status === 'signed') return signedAt ? `已簽署，${signedAt.slice(0, 16)}` : '已簽署';
  return NOT_YET_SIGNED;
}

export function signatureRecordCards(records: readonly SignatureRecordDetail[]): SignatureRecordCard[] {
  return records.map((detail) => {
    const kind = detail.snapshotAtSend.certificateKind;
    const concurrent = detail.concurrentRoles.map((role) => SIGNER_ROLE_LABELS[role]);
    return {
      key: detail.ruleId,
      title: detail.signer.name,
      summary: [
        { label: '簽章人', value: kind ? `${detail.signer.name}（${practitionerTitle(kind)}）` : detail.signer.name },
        { label: '執業主體', value: detail.entityName ?? detail.entityId },
        { label: '依據款次', value: detail.statuteRef },
        { label: '規則', value: `${detail.ruleId}，版本 ${detail.ruleVersion}` },
        { label: '兼任角色', value: concurrent.length > 0 ? concurrent.join('、') : '無' },
        { label: '簽署狀態', value: signStatusText(detail) },
      ],
      snapshotRows: SNAPSHOT_ROWS.map((row) => ({
        key: row.key,
        label: row.label,
        atSend: row.value(detail.snapshotAtSend),
        atSign: signCell(row, detail),
      })),
    };
  });
}
