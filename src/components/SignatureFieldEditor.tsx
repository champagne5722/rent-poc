'use client';

import { useEffect, useRef, useState } from 'react';
import { Rnd } from 'react-rnd';
import { Alert, Button, Flex, Spin, Typography } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import {
  CONTRACT_PARTY_ROLES,
  SIGNER_ROLE_LABELS,
  type SignatureField,
  type SignerRole,
} from '@/lib/types';
import { printOrder, seatOfField, seatViewsMissingStatusAnnex, type SeatView } from '@/lib/signature-routing';
import { pageMapFromTexts, type PdfPageMap } from '@/lib/pdf-layout';
import {
  type AlignGuide,
  clampRect,
  defaultFieldRect,
  overlapWarning,
  overlappingFieldIds,
  snapPosition,
  snapThresholdRatio,
} from '@/lib/signature-layout';

// 簽署區域編輯器：pdf.js 逐頁渲染 + react-rnd 拖放簽名框。
// 新增按鈕由簽署序列的席位驅動（ADR-0021 決議 5），每個席位一顆，新增的框寫入 slot。
// 沒有給 seats 時（舊用法）只有甲方、乙方兩顆，框不帶 slot。按鈕依印列順序（甲方、乙方、執業人員）排，與簽署順序無關。
// 簽名頁與現況確認附件頁由 PDF 文字判定（pdf-layout.ts 的 pageMapFromTexts），不用「最後一頁」推測（MIL-162）。
// 讀完 PDF 後把頁面地圖回報給呼叫端（onPageMap），wizard 用它檢查附件頁有沒有執業人員的簽名框。
// 內部座標一律存「相對該頁的比例」（原點左上、y 向下）；
// 送簽時才由後端轉成點點簽的 coord（原點左下），見 lib/signing-module/dottedsign-adapter.ts。
// 預設落點、吸附／對齊線、出界夾回與重疊偵測都是 lib/signature-layout.ts 的純函式，這裡只做換算與畫面。
interface Props {
  pdfUrl: string;
  value: SignatureField[];
  onChange?: (fields: SignatureField[]) => void;
  readOnly?: boolean;
  /** 簽署序列的席位。沒有時是甲方、乙方兩個席位。 */
  seats?: readonly SeatView[];
  /** PDF 載入完成後回報頁面地圖（簽名頁與現況確認附件頁的頁碼）。必須是穩定的函式（例如 useState 的 setter），否則每次繪製都會重新載入 PDF。 */
  onPageMap?: (pages: PdfPageMap) => void;
}

interface RenderedPage {
  index: number;
  dataUrl: string;
  cssWidth: number;
  cssHeight: number;
}

const SIGNER_STYLES: Record<SignerRole, { color: string; bg: string }> = {
  party_a: { color: '#1677ff', bg: 'rgba(22,119,255,0.12)' },
  party_b: { color: '#fa8c16', bg: 'rgba(250,140,22,0.14)' },
  // 執業人員的簽名框，顏色取 DESIGN.md 的 ink-muted。
  practitioner: { color: '#5d606b', bg: 'rgba(93,96,107,0.12)' },
};

const RENDER_WIDTH = 680;
const GUIDE_COLOR = '#eb2f96';
const OVERLAP_COLOR = '#ff4d4f';

/** 拖曳中要畫的對齊線；只畫在當下操作的那一頁。 */
interface ActiveGuides {
  page: number;
  guides: AlignGuide[];
}

/** 舊用法沒有簽署序列：只有甲方、乙方兩個席位，印列順序就是按鈕順序。 */
const PARTY_ONLY_BUTTONS = CONTRACT_PARTY_ROLES.map((role) => ({
  role,
  slot: undefined as string | undefined,
  label: SIGNER_ROLE_LABELS[role],
}));

export default function SignatureFieldEditor({ pdfUrl, value, onChange, readOnly, seats, onPageMap }: Props) {
  const [pages, setPages] = useState<RenderedPage[] | null>(null);
  const [pageMap, setPageMap] = useState<PdfPageMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeGuides, setActiveGuides] = useState<ActiveGuides | null>(null);
  const idSeq = useRef(0);
  // 以 ref 持有最新值，避免同一 tick 內連續操作（如快速連點）拿到 stale state
  const valueRef = useRef(value);
  valueRef.current = value;
  const emit = (next: SignatureField[]) => {
    valueRef.current = next;
    onChange?.(next);
  };

  useEffect(() => {
    let cancelled = false;
    setPages(null);
    setPageMap(null);
    setError(null);
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
        const doc = await pdfjs.getDocument({ url: pdfUrl }).promise;
        const rendered: RenderedPage[] = [];
        const texts: string[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          texts.push(((await page.getTextContent()).items as { str?: string }[]).map((item) => item.str ?? '').join(''));
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = RENDER_WIDTH / baseViewport.width;
          const viewport = page.getViewport({ scale: scale * 2 }); // 2x 供 retina
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
          rendered.push({
            index: i - 1,
            dataUrl: canvas.toDataURL('image/png'),
            cssWidth: RENDER_WIDTH,
            cssHeight: (baseViewport.height / baseViewport.width) * RENDER_WIDTH,
          });
          if (cancelled) return;
        }
        if (!cancelled) {
          const map = pageMapFromTexts(texts);
          setPages(rendered);
          setPageMap(map);
          onPageMap?.(map);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'PDF 載入失敗');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfUrl, onPageMap]);

  // 範本的簽名欄在「立契約書人」所在的頁；新增框優先落在那一頁的簽名欄旁。有附件頁時它不是最後一頁。
  const signaturePage = pageMap?.signaturePage ?? 0;
  // 現況確認附件頁：規則列要求簽章的席位，預設落點在附件頁頁底的簽署欄旁（MIL-71）
  const annexSeats = seats?.filter((seat) => seat.requiresStatusAnnex) ?? [];
  const statusAnnex =
    pageMap?.statusAnnexPage != null && annexSeats.length > 0
      ? { page: pageMap.statusAnnexPage, slots: annexSeats.map((seat) => seat.ruleId) }
      : undefined;
  const annexMissing = seats && pageMap ? seatViewsMissingStatusAnnex(seats, value, pageMap.statusAnnexPage) : [];

  const layoutSeats = seats?.map((seat) => ({ role: seat.role, slot: seat.ruleId }));
  const buttons = seats
    ? printOrder(seats).map((seat) => ({ role: seat.role, slot: seat.ruleId as string | undefined, label: seat.label }))
    : PARTY_ONLY_BUTTONS;

  const addField = (signer: SignerRole, slot: string | undefined, page: number) => {
    const rect = defaultFieldRect({
      signer,
      slot,
      seats: layoutSeats,
      page,
      signaturePage,
      statusAnnex,
      existing: valueRef.current,
    });
    const field: SignatureField = {
      id: `sf-${Date.now()}-${idSeq.current++}`,
      signer,
      ...(slot ? { slot } : {}),
      page,
      ...rect,
    };
    emit([...valueRef.current, field]);
  };

  /** 簽名框上的文字：有簽署序列時用席位名稱，區分管理人員與經紀人。 */
  const fieldLabel = (f: SignatureField) => (seats && seatOfField(f, seats)?.label) || SIGNER_ROLE_LABELS[f.signer];

  const updateField = (id: string, patch: Partial<SignatureField>) => {
    emit(valueRef.current.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };

  const removeField = (id: string) => {
    emit(valueRef.current.filter((f) => f.id !== id));
  };

  if (error) return <Typography.Text type="danger">{error}</Typography.Text>;
  if (!pages) return <Spin tip="載入合約 PDF…" style={{ display: 'block', margin: '48px auto' }} />;

  const warning = overlapWarning(value);
  const overlappingIds = overlappingFieldIds(value);

  return (
    <div>
      {warning && (
        <Alert type="warning" showIcon message={warning} style={{ marginBottom: 12 }} />
      )}
      {!readOnly && annexMissing.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`現況確認附件頁尚未放置${annexMissing.map((seat) => seat.label).join('、')}簽名框`}
          description="包租租賃合約的現況確認附件須由執業人員簽章。請在標示「現況確認附件頁」的那一頁新增簽名框。"
          style={{ marginBottom: 12 }}
        />
      )}
      {pages.map((page) => {
        const pageSize = { width: page.cssWidth, height: page.cssHeight };
        const threshold = snapThresholdRatio(pageSize);
        // 舊草稿或縮放到頁緣可能留下超出範圍的座標，畫之前先夾回頁內，下一次拖放就會把夾回值存回去
        const onPage = value
          .filter((f) => f.page === page.index)
          .map((f) => ({ ...f, ...clampRect(f) }));
        // 把 react-rnd 的 px 位置換成比例後吸附，回傳吸附結果與該畫的對齊線
        const snapForDrag = (field: SignatureField, px: { x: number; y: number }) =>
          snapPosition(
            { x: px.x / page.cssWidth, y: px.y / page.cssHeight, w: field.w, h: field.h },
            onPage.filter((f) => f.id !== field.id),
            threshold
          );
        return (
          <div key={page.index} style={{ marginBottom: 24 }}>
            <Flex wrap align="center" justify="space-between" gap={8} style={{ marginBottom: 8 }}>
              <Typography.Text type="secondary">
                第 {page.index + 1} 頁{page.index === signaturePage && '（範本簽名頁）'}
                {page.index === pageMap?.statusAnnexPage && '（現況確認附件頁）'}
              </Typography.Text>
              {!readOnly && (
                <Flex wrap gap={8} justify="flex-end">
                  {buttons.map((button) => (
                    <Button
                      key={button.slot ?? button.role}
                      size="small"
                      onClick={() => addField(button.role, button.slot, page.index)}
                    >
                      ＋ {button.label}簽名框
                    </Button>
                  ))}
                </Flex>
              )}
            </Flex>
            <div
              style={{
                position: 'relative',
                width: page.cssWidth,
                height: page.cssHeight,
                border: '1px solid #d9d9d9',
                background: '#fff',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={page.dataUrl}
                alt={`合約第 ${page.index + 1} 頁`}
                style={{ width: '100%', height: '100%', display: 'block', userSelect: 'none' }}
                draggable={false}
              />
              {activeGuides?.page === page.index &&
                activeGuides.guides.map((guide) => (
                  <div
                    key={`${guide.orientation}-${guide.position}`}
                    style={
                      guide.orientation === 'vertical'
                        ? {
                            position: 'absolute',
                            left: guide.position * page.cssWidth,
                            top: 0,
                            width: 1,
                            height: '100%',
                            background: GUIDE_COLOR,
                            pointerEvents: 'none',
                          }
                        : {
                            position: 'absolute',
                            top: guide.position * page.cssHeight,
                            left: 0,
                            height: 1,
                            width: '100%',
                            background: GUIDE_COLOR,
                            pointerEvents: 'none',
                          }
                    }
                  />
                ))}
              {onPage.map((f) => {
                const style = SIGNER_STYLES[f.signer];
                const overlapping = overlappingIds.has(f.id);
                return (
                  <Rnd
                    key={f.id}
                    bounds="parent"
                    disableDragging={readOnly}
                    enableResizing={!readOnly}
                    size={{ width: f.w * page.cssWidth, height: f.h * page.cssHeight }}
                    position={{ x: f.x * page.cssWidth, y: f.y * page.cssHeight }}
                    onDrag={(_e, d) => setActiveGuides({ page: page.index, guides: snapForDrag(f, d).guides })}
                    onDragStop={(_e, d) => {
                      const snapped = snapForDrag(f, d);
                      setActiveGuides(null);
                      updateField(f.id, { x: snapped.x, y: snapped.y });
                    }}
                    onResizeStop={(_e, _dir, ref, _delta, pos) =>
                      updateField(
                        f.id,
                        clampRect({
                          x: pos.x / page.cssWidth,
                          y: pos.y / page.cssHeight,
                          w: ref.offsetWidth / page.cssWidth,
                          h: ref.offsetHeight / page.cssHeight,
                        })
                      )
                    }
                    style={{
                      border: `2px dashed ${overlapping ? OVERLAP_COLOR : style.color}`,
                      background: overlapping ? 'rgba(255,77,79,0.14)' : style.bg,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        color: overlapping ? OVERLAP_COLOR : style.color,
                        fontSize: 12,
                        pointerEvents: readOnly ? 'none' : undefined,
                      }}
                    >
                      {fieldLabel(f)}簽名
                      {!readOnly && (
                        <DeleteOutlined
                          onClick={(e) => {
                            e.stopPropagation();
                            removeField(f.id);
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          style={{ cursor: 'pointer' }}
                        />
                      )}
                    </div>
                  </Rnd>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
