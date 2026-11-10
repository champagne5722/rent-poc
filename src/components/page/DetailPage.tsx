'use client';

import { Col, Flex, Row } from 'antd';
import type { ReactNode } from 'react';
import PageHeader, { type PageHeaderProps } from './PageHeader';

// 詳情頁版型（MIL-175、ADR-0090）：頁首、「下一步」區塊、主要內容、屬性側欄。
// 只組合 antd 的 Flex、Row、Col 與 PageHeader，不覆寫外觀。參考 ant-design-pro 的 profile/advanced，
// 只取版面的組合：頁首在上，狀態與下一步緊接在下，主要內容在左，屬性在右。
// 標記為 client component：PageHeader 用了 @ant-design/icons；server component 仍然能渲染它。
// 資料與操作由頁面決定，這個元件只排版。用法見 docs/ui/composite-components.md。

export interface DetailPageProps {
  /** 傳給 PageHeader。詳情頁必須給 `back`。 */
  header: PageHeaderProps;
  /** 頁首下方的「下一步」區塊，用 NextStep。 */
  nextStep?: ReactNode;
  /** 「下一步」區塊上方的提醒，例如簽署中失效的警示。 */
  notices?: ReactNode;
  /** 主要內容：依重要性由上而下排列的區段。 */
  children: ReactNode;
  /** 屬性側欄。 */
  aside: ReactNode;
}

// 主要內容與側欄的欄寬（24 欄制）。窄於 xl 時側欄排到主要內容下方。
const MAIN_SPAN = 16;
const ASIDE_SPAN = 8;

export default function DetailPage({ header, nextStep, notices, children, aside }: DetailPageProps) {
  return (
    <Flex vertical gap="large">
      <PageHeader {...header} />
      {notices}
      {nextStep}
      <Row gutter={[24, 24]}>
        <Col xs={24} xl={MAIN_SPAN}>
          <Flex vertical gap="large">
            {children}
          </Flex>
        </Col>
        <Col xs={24} xl={ASIDE_SPAN}>
          <Flex vertical gap="large">
            {aside}
          </Flex>
        </Col>
      </Row>
    </Flex>
  );
}
