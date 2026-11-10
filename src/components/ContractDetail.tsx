"use client";

// 合約詳情頁的畫面與操作（規格 §8，MIL-175、ADR-0090）。資料由 server component（contracts/[id]/(detail)/page.tsx）載入後傳進來。
// 版面用 DetailPage：頁首（狀態、主要動作、返回列表）、「下一步」區塊、主要內容、屬性側欄。
// 草稿不在此頁編輯欄位，編輯一律回建約 wizard（規格 §7、MIL-12 決議）。
// 狀態變更（撤回、模擬拒簽）用 optimistic update：按下就先顯示新狀態，失敗時還原並顯示原因與下一步。

import { useEffect, useState, useTransition } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Flex,
  Popconfirm,
  Steps,
  Table,
  Tag,
  Timeline,
  Typography,
} from "antd";
import {
  ArrowRightOutlined,
  CopyOutlined,
  DownloadOutlined,
  EditOutlined,
  FileDoneOutlined,
  FileProtectOutlined,
  ReloadOutlined,
  RollbackOutlined,
} from "@ant-design/icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ContractDetailData } from "@/lib/contract-detail-load";
import type { LeaseContract, ContractStatus } from "@/lib/types";
import { isSigningStatus } from "@/lib/types";
import StatusTag from "@/components/StatusTag";
import DetailPage from "@/components/page/DetailPage";
import NextStep from "@/components/page/NextStep";
import { DisplayCode } from "@/components/DisplayCode";
import SignatureFieldEditor from "@/components/SignatureFieldEditor";
import { contractSigningSteps } from "@/lib/contract-list";
import {
  contractChainNodes,
  contractEventEntries,
  contractFileDownloadHref,
  contractFileRows,
  detailActions,
  equipmentAnnexSummary,
  mockAdvanceActions,
  type ContractFileRow,
} from "@/lib/contract-detail";
import { contractNextStep, headerActionKeys } from "@/lib/contract-next-step";
import { shortUlid } from "@/lib/pg/ulid";
import { evaluateRouting } from "@/lib/signature-routing";
import {
  signingStepStateLabel,
  type SigningStepState,
} from "@/lib/signing-steps";
import {
  STATUS_ANNEX_TITLE,
  statusAnnexOf,
  statusAnnexSummary,
} from "@/lib/status-annex";
import { signatureRecordCards } from "@/lib/signature-records/view";
import { lapseAlerts } from "@/lib/signing-lapse/view";
import styles from "./ContractDetail.module.css";

const FILE_ICONS = {
  signed_pdf: <FileDoneOutlined />,
  audit_trail: <FileProtectOutlined />,
};

const STEP_STATUS = {
  signed: "finish",
  current: "process",
  waiting: "wait",
  declined: "error",
} as const satisfies Record<
  SigningStepState,
  "finish" | "process" | "wait" | "error"
>;

function formatSize(bytes: number | null): string {
  if (bytes == null) return "";
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

// 金額固定用 en-US 分組：server component 先渲染一次，伺服器與瀏覽器的語系不同時，文字才不會不一致
function formatMoney(value: number | null | undefined): string {
  return value != null ? `$${value.toLocaleString("en-US")}` : "—";
}

/** 操作失敗後留在畫面上的說明：原因與下一步。畫面已還原成操作前的狀態。 */
interface ActionFailure {
  title: string;
  reason: string;
  next: string;
}

const CHECK_STATUS_NEXT =
  "畫面已還原成操作前的狀態。請重新整理頁面確認合約狀態，再決定是否重試。";

function Lines({ lines }: { lines: string[] }) {
  return (
    <Flex vertical>
      {lines.map((line) => (
        <Typography.Text key={line}>{line}</Typography.Text>
      ))}
    </Flex>
  );
}

function ContractDetailInner(data: ContractDetailData) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  // 狀態變更送出期間，所有會改變狀態的按鈕停用：畫面已先顯示新狀態，但伺服器還沒確認，這時再操作會對不上
  const [changing, startTransition] = useTransition();
  const contract = data.contract as LeaseContract;
  const id = contract.id;
  const {
    relations,
    signingProgress,
    events,
    files,
    practitioners,
    signatureRecords,
    signingLapses,
    displayCode,
    mock,
  } = data;

  // optimistic 狀態連同它建立當下的伺服器狀態一起存：伺服器狀態一變（router.refresh 載入新資料），就不再套用
  const [optimistic, setOptimistic] = useState<{
    forStatus: ContractStatus;
    status: ContractStatus;
  } | null>(null);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const [signLinkState, setSignLinkState] = useState<{
    forStatus: ContractStatus;
    link: string;
  } | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [refetching, setRefetching] = useState(false);
  const [copying, setCopying] = useState(false);

  const serverStatus = contract.status;
  const status =
    optimistic?.forStatus === serverStatus ? optimistic.status : serverStatus;
  const view = { ...contract, status };

  // 簽署中每 5 秒重新載入一次，讓 webhook 更新反映到畫面
  useEffect(() => {
    if (!isSigningStatus(serverStatus)) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [serverStatus, router]);

  async function post<T = Record<string, string>>(
    path: string,
    body?: object,
  ): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: json.error ?? "操作失敗" };
      return { ok: true, data: json.data };
    } catch {
      return { ok: false, error: "無法連線到伺服器" };
    }
  }

  // 先顯示新狀態，再送出請求。失敗時還原並顯示原因與下一步，成功時重新載入
  function changeStatus(options: {
    to: ContractStatus;
    path: string;
    body?: object;
    failTitle: string;
    success: string;
  }) {
    setFailure(null);
    setOptimistic({ forStatus: serverStatus, status: options.to });
    startTransition(async () => {
      const result = await post(options.path, options.body);
      if (!result.ok) {
        setOptimistic(null);
        setFailure({
          title: options.failTitle,
          reason: result.error,
          next: CHECK_STATUS_NEXT,
        });
        return;
      }
      message.success(options.success);
      router.refresh();
    });
  }

  const routing = evaluateRouting(
    contract.fields.routing,
    contract.contract_type,
  );
  const isDraft = status === "draft";
  const isSigning = isSigningStatus(status);
  const signer = signingProgress?.currentSigner ?? null;
  const declinedRole =
    signingProgress?.signers.find((s) => s.status === "declined")?.role ?? null;
  const signingSteps = contractSigningSteps(view, signingProgress);
  const mockActions = mockAdvanceActions(status, signingProgress);
  const signLink =
    signLinkState?.forStatus === status ? signLinkState.link : null;
  const eventEntries = contractEventEntries(events);
  const fileRows = contractFileRows(view, files, { mock });
  const annexSummary = equipmentAnnexSummary(contract.fields);
  // 現況確認附件（MIL-71）：草稿依分流條件顯示，送簽後只顯示凍結的內容，舊的包租合約沒有就不顯示
  const statusAnnex = statusAnnexOf(
    status,
    contract.contract_type,
    contract.fields,
  );
  const statusAnnexLines = statusAnnex ? statusAnnexSummary(statusAnnex) : [];
  const chain = contractChainNodes(view, relations);
  const recordCards = signatureRecordCards(signatureRecords);
  const lapseNotices = lapseAlerts(signingLapses, status);
  const voidAction = detailActions("awaiting_tenant", { mock }).find(
    (a) => a.key === "void",
  );
  const copyAction = detailActions("voided", { mock }).find(
    (a) => a.key === "copy",
  );
  const nextStep = contractNextStep({
    status,
    contractType: contract.contract_type,
    currentSigner: signer,
    declinedRole,
    declinedReason: contract.declined_reason ?? null,
    mock,
  });

  const voidContract = () =>
    changeStatus({
      to: "voided",
      path: `/api/contracts/${id}/void`,
      failTitle: "撤回失敗",
      success: "已撤回",
    });

  const copyAsDraft = async () => {
    setCopying(true);
    const result = await post(`/api/contracts/${id}/copy`);
    setCopying(false);
    if (!result.ok) {
      setFailure({
        title: "複製為新草稿失敗",
        reason: result.error,
        next: "合約沒有變動。請稍後再按一次「複製為新草稿」。",
      });
      return;
    }
    message.success("已複製為新草稿");
    router.push(`/contracts/${result.data.id}`);
  };

  const fetchSignLink = async () => {
    setLinkLoading(true);
    const res = await fetch(`/api/contracts/${id}/sign-link`);
    const json = await res.json().catch(() => ({}));
    setLinkLoading(false);
    if (!res.ok) {
      message.error(json.error ?? "取得簽署連結失敗");
      return;
    }
    setSignLinkState({ forStatus: status, link: json.data.sign_link });
  };

  const resend = async () => {
    setResending(true);
    const result = await post(`/api/contracts/${id}/resend`);
    setResending(false);
    if (result.ok) message.success(`已重寄簽署通知至 ${result.data.resent_to}`);
    else message.error(result.error);
  };

  const mockAdvance = (event: string, label: string) =>
    changeStatus({
      // 只有拒簽的結果一定是已拒簽。其他事件的下一個狀態由簽署序列決定，等伺服器回應再更新
      to: event === "declined" ? "declined" : serverStatus,
      path: "/api/mock/advance",
      body: { contract_id: id, event },
      failTitle: "模擬簽署失敗",
      success: label,
    });

  // 補抓：完成當下抓檔失敗（點點簽暫時性錯誤、連結過期）時的補救
  const refetchFiles = async () => {
    setRefetching(true);
    const res = await fetch(`/api/contracts/${id}/files`, { method: "POST" });
    const json = await res.json().catch(() => ({}));
    setRefetching(false);
    if (!res.ok) {
      message.error(json.error ?? "補抓文件失敗");
      return;
    }
    const failed = (json.data.results ?? []).filter(
      (r: { ok: boolean }) => !r.ok,
    );
    if (failed.length)
      message.warning("部分文件仍保存失敗，詳見文件區的錯誤訊息");
    else message.success("已補抓文件");
    router.refresh();
  };

  const voidButton = (size?: "small") => (
    <Popconfirm title={voidAction?.confirm} onConfirm={voidContract}>
      <Button
        danger
        size={size}
        icon={<RollbackOutlined />}
        disabled={changing}
      >
        撤回
      </Button>
    </Popconfirm>
  );

  const headerExtra = headerActionKeys(status, { mock }).map((key) => {
    switch (key) {
      case "edit":
        return (
          <Link key={key} href={`/contracts/${id}/edit`}>
            <Button type="primary" icon={<EditOutlined />}>
              繼續編輯
            </Button>
          </Link>
        );
      case "signed_pdf":
        return (
          <Button
            key={key}
            type="primary"
            icon={<DownloadOutlined />}
            href={contractFileDownloadHref(id, "signed_pdf")}
          >
            下載已簽 PDF
          </Button>
        );
      case "audit_trail":
        return (
          <Button
            key={key}
            icon={<DownloadOutlined />}
            href={contractFileDownloadHref(id, "audit_trail")}
          >
            下載 Audit Trail File
          </Button>
        );
    }
  });

  const nextStepActions = nextStep.actionKeys.map((key) =>
    key === "void" ? (
      <span key={key}>{voidButton()}</span>
    ) : (
      <Button
        key={key}
        type="primary"
        icon={<CopyOutlined />}
        loading={copying}
        disabled={changing}
        onClick={() => void copyAsDraft()}
      >
        {copyAction?.label ?? "複製為新草稿"}
      </Button>
    ),
  );

  const fileAction = (row: ContractFileRow) => {
    switch (row.state) {
      case "saved":
        return (
          <Flex align="center" gap="small">
            <Typography.Text type="secondary" className="type-caption">
              {formatSize(row.file?.byte_size ?? null)}
            </Typography.Text>
            <Button
              size="small"
              icon={<DownloadOutlined />}
              href={row.downloadHref}
            >
              下載
            </Button>
          </Flex>
        );
      case "failed":
        return (
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={refetching}
            onClick={() => void refetchFiles()}
          >
            補抓
          </Button>
        );
      case "pending":
        return status === "completed" ? (
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={refetching}
            onClick={() => void refetchFiles()}
          >
            補抓
          </Button>
        ) : (
          <Typography.Text type="secondary">尚未產生</Typography.Text>
        );
      case "unavailable":
        return <Typography.Text type="secondary">不適用</Typography.Text>;
    }
  };

  const notices = (
    <>
      {failure && (
        <Alert
          type="error"
          showIcon
          closable={{ onClose: () => setFailure(null) }}
          title={failure.title}
          description={`原因：${failure.reason}。${failure.next}`}
        />
      )}
      {lapseNotices.length > 0 && (
        <Flex vertical gap="small">
          {lapseNotices.map((notice) => (
            <Alert
              key={notice.key}
              type={notice.type}
              showIcon
              title={notice.title}
              description={notice.description}
              action={notice.canVoid ? voidButton("small") : undefined}
            />
          ))}
        </Flex>
      )}
    </>
  );

  const nextStepBlock = (
    <NextStep
      headline={nextStep.headline}
      owner={nextStep.owner}
      detail={nextStep.detail}
      tone={nextStep.tone}
      actions={nextStepActions.length > 0 ? nextStepActions : undefined}
    >
      {isSigning && signer && !mock && (
        <Flex vertical gap="small">
          <Flex align="center" gap="small" wrap="wrap">
            <Button
              size="small"
              loading={linkLoading}
              onClick={() => void fetchSignLink()}
            >
              取得簽署連結
            </Button>
            <Button
              size="small"
              loading={resending}
              onClick={() => void resend()}
            >
              重寄簽署通知
            </Button>
          </Flex>
          {signLink && (
            <Flex align="center" gap="small">
              <Typography.Link
                href={signLink}
                target="_blank"
                ellipsis
                className={styles.linkText}
              >
                {signLink}
              </Typography.Link>
              <Typography.Text
                copyable={{ text: signLink, tooltips: ["複製連結", "已複製"] }}
              />
            </Flex>
          )}
        </Flex>
      )}
      {mock && isSigning && (
        <Flex align="center" gap="small" wrap="wrap">
          <Typography.Text type="secondary">模擬 webhook：</Typography.Text>
          {mockActions.map((action) => (
            <Button
              key={`${action.event}-${action.label}`}
              size="small"
              danger={action.danger}
              disabled={changing}
              onClick={() => mockAdvance(action.event, action.message)}
            >
              {action.label}
            </Button>
          ))}
        </Flex>
      )}
    </NextStep>
  );

  const progressItems = [
    ...signingSteps.steps.map((step) => ({
      title: `待${step.fullLabel}簽署`,
      content: `${step.name ?? "（尚未指定）"}・${signingStepStateLabel(step.state)}`,
      status: STEP_STATUS[step.state],
    })),
    {
      title: "完成",
      content: undefined,
      status: signingSteps.completed ? ("finish" as const) : ("wait" as const),
    },
  ];

  const attributes = (
    <Card size="small" title="合約屬性">
      <Descriptions
        column={1}
        size="small"
        items={[
          {
            key: "id",
            label: "合約編號",
            children: (
              <Typography.Text copyable={{ text: contract.id }}>
                {shortUlid(contract.id)}
              </Typography.Text>
            ),
          },
          {
            key: "property",
            label: "物件",
            children: contract.fields.propertyName,
          },
          ...(displayCode === undefined
            ? []
            : [
                {
                  key: "display-code",
                  label: "顯示編碼",
                  children: <DisplayCode code={displayCode} />,
                },
              ]),
          {
            key: "address",
            label: "地址",
            children: contract.fields.propertyAddress,
          },
          {
            key: "landlord",
            label: "甲方",
            children: `${contract.fields.landlordName}（${contract.fields.landlordEmail}）`,
          },
          {
            key: "tenant",
            label: "乙方",
            children: `${contract.fields.tenantName}（${contract.fields.tenantEmail}）`,
          },
          ...(Object.keys(practitioners).length > 0
            ? [
                {
                  key: "practitioners",
                  label: "執業人員",
                  children: (
                    <Lines
                      lines={Object.values(practitioners).map(
                        (p) =>
                          `${p.name}${p.title ? `（${p.title}）` : ""}・${p.entityName}`,
                      )}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
    </Card>
  );

  const history = (
    <Card size="small" title="合約歷程">
      <Flex vertical gap="middle">
        <Typography.Text type="secondary">
          此為活動歷程（只記里程碑事件）。草稿編輯與下載、查看不記錄。法律舉證以點點簽
          Audit Trail File 為準（ADR-0007）。
        </Typography.Text>
        {eventEntries.length === 0 ? (
          <Typography.Text type="secondary">尚無歷程事件</Typography.Text>
        ) : (
          <Timeline
            mode="start"
            items={eventEntries.map((e) => ({
              key: e.key,
              color: e.color,
              title: e.time,
              content: (
                <Flex vertical>
                  <Typography.Text strong>{e.label}</Typography.Text>
                  <Typography.Text type="secondary" className="type-caption">
                    行為者：{e.actorLabel}
                  </Typography.Text>
                  {e.note && (
                    <Typography.Text type="secondary" className="type-caption">
                      {e.note}
                    </Typography.Text>
                  )}
                </Flex>
              ),
            }))}
          />
        )}
      </Flex>
    </Card>
  );

  const documents = (
    <Card size="small" title="文件">
      <Flex vertical gap="middle">
        {fileRows.map((row) => (
          <Flex key={row.kind} align="flex-start" gap="middle">
            <span className={styles.fileIcon} aria-hidden>
              {FILE_ICONS[row.kind]}
            </span>
            <Flex vertical className={styles.fileBody}>
              <Typography.Text>{row.label}</Typography.Text>
              <Typography.Text type="secondary" className="type-caption">
                {row.hint}
              </Typography.Text>
              {row.state === "failed" && row.error && (
                <Typography.Text type="danger" className="type-caption">
                  {row.error}
                </Typography.Text>
              )}
            </Flex>
            {fileAction(row)}
          </Flex>
        ))}
      </Flex>
    </Card>
  );

  return (
    <DetailPage
      header={{
        title: `合約 #${shortUlid(contract.id)}`,
        tag: (
          <>
            <StatusTag kind="contract" value={status} />
            {mock && <Tag>mock 模式</Tag>}
          </>
        ),
        extra: headerExtra.length > 0 ? headerExtra : undefined,
        back: { href: "/contracts", label: "返回合約列表" },
      }}
      notices={notices}
      nextStep={nextStepBlock}
      wide={
        <>
          {recordCards.length > 0 && (
            <Card size="small" title="簽章紀錄">
              <Flex vertical gap="large">
                <Typography.Text type="secondary">
                  送簽與簽署當下的執業人員資料留存，只供查看。法律舉證以點點簽的
                  Audit Trail File 為準。
                </Typography.Text>
                {recordCards.map((card) => (
                  <Flex key={card.key} vertical gap="middle">
                    <h3 className="type-section-title">{card.title}</h3>
                    <Descriptions
                      column={{ xs: 1, md: 2 }}
                      size="small"
                      items={card.summary.map((item) => ({
                        key: item.label,
                        label: item.label,
                        children: item.value,
                      }))}
                    />
                    <Table
                      size="middle"
                      rowKey="key"
                      pagination={false}
                      scroll={{ x: "max-content" }}
                      dataSource={card.snapshotRows}
                      columns={[
                        { title: "證書快照", dataIndex: "label" },
                        { title: "送簽時", dataIndex: "atSend", width: "38%" },
                        { title: "簽署時", dataIndex: "atSign", width: "38%" },
                      ]}
                    />
                  </Flex>
                ))}
              </Flex>
            </Card>
          )}
          <Card
            size="small"
            title={isDraft ? "合約預覽（唯讀）" : "合約內容與簽署區域"}
          >
            <SignatureFieldEditor
              pdfUrl={`/api/contracts/${id}/pdf`}
              value={contract.signature_fields}
              readOnly
              seats={routing.ok ? routing.seats : undefined}
            />
          </Card>
        </>
      }
      aside={
        <>
          {attributes}
          {documents}
          {history}
        </>
      }
    >
      {!isDraft && (
        <Card size="small" title="簽署進度">
          <Steps
            orientation="vertical"
            size="small"
            items={progressItems.map(({ title, content, status: s }) => ({
              title,
              content,
              status: s,
            }))}
          />
        </Card>
      )}

      <Card size="small" title="租賃條件">
        <Descriptions
          column={1}
          size="small"
          items={[
            {
              key: "rent",
              label: "月租金",
              children: formatMoney(contract.fields.rent),
            },
            {
              key: "deposit",
              label: "押金",
              children: formatMoney(contract.fields.deposit),
            },
            {
              key: "lease",
              label: "租期",
              children: `${contract.fields.startDate} ~ ${contract.fields.endDate}`,
            },
          ]}
        />
      </Card>

      <Card size="small" title="條款與附件">
        <Descriptions
          column={1}
          size="small"
          items={[
            {
              key: "template",
              label: "範本",
              children: contract.fields.templateVersion
                ? `住宅租賃契約 v${contract.fields.templateVersion}（平台提供）`
                : "住宅租賃契約（未綁定版本，MIL-26 之前建立）",
            },
            {
              key: "clauses",
              label: "選用條款",
              children: contract.fields.clauses?.length
                ? contract.fields.clauses.map((c) => c.title).join("、")
                : "無",
            },
            {
              key: "equipmentAnnex",
              label: "設備附件",
              children: annexSummary.length ? (
                <Lines lines={annexSummary} />
              ) : (
                "無附屬設備"
              ),
            },
            ...(statusAnnexLines.length > 0
              ? [
                  {
                    key: "statusAnnex",
                    label: STATUS_ANNEX_TITLE,
                    children: <Lines lines={statusAnnexLines} />,
                  },
                ]
              : []),
            {
              key: "extra",
              label: "其他約定事項",
              children: contract.fields.extra || "無",
            },
          ]}
        />
      </Card>

      {chain.length > 0 && (
        <Card size="small" title="關聯合約">
          <Flex align="center" gap="middle" wrap="wrap">
            {chain.map((node, i) => (
              <Flex key={node.id} align="center" gap="middle">
                {i > 0 && <ArrowRightOutlined aria-hidden />}
                <Flex vertical className={styles.chainNode}>
                  <Flex align="center" gap="small">
                    {node.href ? (
                      <Link href={node.href} title={node.id}>
                        合約 #{shortUlid(node.id)}
                      </Link>
                    ) : (
                      <Typography.Text strong title={node.id}>
                        合約 #{shortUlid(node.id)}
                      </Typography.Text>
                    )}
                    <StatusTag kind="contract" value={node.status} />
                  </Flex>
                  <Typography.Text type="secondary" className="type-caption">
                    {node.note}
                  </Typography.Text>
                </Flex>
              </Flex>
            ))}
          </Flex>
        </Card>
      )}
    </DetailPage>
  );
}

export default function ContractDetail(props: ContractDetailData) {
  return (
    <AntApp>
      <ContractDetailInner {...props} />
    </AntApp>
  );
}
