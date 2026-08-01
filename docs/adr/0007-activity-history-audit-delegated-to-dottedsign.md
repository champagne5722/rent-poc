# 合約歷程定位為活動時間軸；稽核級舉證交給點點簽 Audit Trail File

平台側的合約歷程是**活動歷程**，不是稽核級紀錄（MIL-15 決議）：append-only 的里程碑事件序列（建立含衍生來源、送簽、乙方簽署、拒簽含原因、甲方簽署完成、撤回、被複製為新草稿），草稿編輯流水與下載／查看等讀式操作不記。法律舉證由點點簽承擔——任務完成時點點簽自動產生受其數位簽章保護的 Audit Trail File（含各方姓名、Email、時間戳、IP、裝置），平台於合約完成時自動下載保存（與已簽 PDF 並列），詳情頁提供下載。平台不重做稽核級紀錄，避免與簽署服務商的證明文件重疊且法律效力反而較弱。

## Consequences

- 資料模型新增 Contract Event（附屬合約的 append-only 事件：型別、行為者、時間、附註）；點點簽 webhook 事件與狀態轉移在同一次交易寫入，保證歷程與狀態一致。
- 歷程隨合約生命週期保存，不設獨立清除；UI 無編輯與刪除。
- 完成流程多一步：抓取並保存 Audit Trail File（研究筆記：branch `research/dottedsign-signing-history`——現有 `sign_tasks.download.read` scope 即可，`file_types[]=audit_trail`）。
- 若未來需要平台側稽核級紀錄（含讀式操作、IP 記錄），屬新 effort，需重評此決議。
