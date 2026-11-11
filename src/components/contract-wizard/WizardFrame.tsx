'use client';

// 建約精靈的共用版型（MIL-176，ADR-0090）。參考 ant-design-pro 的 step-form：步驟條固定在上方，
// 上一步與下一步固定在下方，內容區只放當前這一步。租賃類與委託管理的精靈、`/contracts/new` 的入口都用它。
// 版型只組合 antd 的 Steps、Alert，不處理資料。每個畫面至多一顆 primary，由呼叫端放在 `next`。

import type { ReactNode } from 'react';
import { Alert, Flex, Steps, Typography } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined, MinusCircleOutlined } from '@ant-design/icons';
import { WIZARD_STEPS, type stepStatuses } from '@/lib/contract-wizard';
import styles from './WizardFrame.module.css';

/** 四步進度條；`/contracts/new` 的第①步也共用這一條。 */
export function WizardStepsBar({ current, statuses }: { current: number; statuses?: ReturnType<typeof stepStatuses> }) {
  return (
    <Steps
      size="small"
      current={current}
      items={WIZARD_STEPS.map((step, index) => ({
        key: step.key,
        title: step.title,
        status: statuses?.[index],
      }))}
    />
  );
}

/** 草稿的儲存狀態：none 是還沒建立草稿，saving 是儲存中，saved 是已儲存，unsaved 是改了還沒存，failed 是上一次儲存失敗。 */
export type DraftState = 'none' | 'saving' | 'saved' | 'unsaved' | 'failed';

const DRAFT_TEXT: Record<DraftState, { text: string; icon: ReactNode; type?: 'secondary' | 'danger' | 'success' }> = {
  none: { text: '按下一步後建立草稿', icon: <MinusCircleOutlined aria-hidden />, type: 'secondary' },
  saving: { text: '草稿儲存中', icon: <LoadingOutlined aria-hidden />, type: 'secondary' },
  saved: { text: '草稿已儲存', icon: <CheckCircleOutlined aria-hidden />, type: 'success' },
  unsaved: { text: '有變更尚未儲存，按下一步後儲存', icon: <MinusCircleOutlined aria-hidden />, type: 'secondary' },
  failed: { text: '草稿尚未儲存', icon: <CloseCircleOutlined aria-hidden />, type: 'danger' },
};

export interface WizardFrameProps {
  /** 這一頁自己的標題。 */
  title: string;
  current: number;
  statuses?: ReturnType<typeof stepStatuses>;
  /** 這一步需要整個內容寬度，例如預覽與簽署區。 */
  wide?: boolean;
  /** 整體錯誤。欄位錯誤顯示在欄位旁，不放這裡。 */
  error?: ReactNode;
  /** 錯誤的下一步動作，例如前往物件的連結。 */
  errorAction?: ReactNode;
  draft: DraftState;
  /** 離開的連結。草稿已保留時寫在這裡，讓使用者離開前看得到草稿狀態。 */
  leave?: ReactNode;
  /** 上一步。第一步時放返回的連結或停用的按鈕，位置不變。 */
  prev: ReactNode;
  /** 下一步或確認送簽。每個畫面至多一顆 primary。 */
  next: ReactNode;
  children: ReactNode;
}

export default function WizardFrame({ title, current, statuses, wide, error, errorAction, draft, leave, prev, next, children }: WizardFrameProps) {
  const draftText = DRAFT_TEXT[draft];
  return (
    <div className={wide ? `${styles.root} ${styles.rootWide}` : styles.root}>
      <div className={styles.top}>
        <h1 className={`type-page-title ${styles.title}`}>{title}</h1>
        <WizardStepsBar current={current} statuses={statuses} />
      </div>

      <div className={styles.body}>
        {children}
        {error && <Alert type="error" showIcon title={error} action={errorAction} role="alert" />}
      </div>

      <div className={styles.footer}>
        <Flex align="center" gap="middle" wrap>
          {leave}
          <Typography.Text type={draftText.type} className={`type-caption ${styles.draftState}`} aria-live="polite">
            {draftText.icon}
            {draftText.text}
          </Typography.Text>
        </Flex>
        <Flex align="center" gap="small">
          {prev}
          {next}
        </Flex>
      </div>
    </div>
  );
}
