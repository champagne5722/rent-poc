-- FileStore 與文件保存（MIL-87，ADR-0012、ADR-0020）。
-- 由 runner 以 app_owner 執行。
--
-- 1. org.sign_task_files 改存物件 key 與 SHA-256，不再存本機路徑。key 必須以 org/<org_id>/ 開頭，
--    不同組織的檔案因此不會撞名，資料庫層也擋得住寫錯前綴。
-- 2. org.outbox 的 action 加 save_sign_task_files：全員完成的同一個交易寫入，提交後派送，失敗留待重試。

-- 1. org.sign_task_files --------------------------------------------------------------
ALTER TABLE org.sign_task_files
  ADD COLUMN object_key text,
  ADD COLUMN sha256     text;

-- 舊的 saved 列只有本機路徑，換實例就讀不到，demo 的已簽 PDF 本來就沒有持久保存。
-- 轉成 failed 並寫明原因，下載時會自動補抓（ADR-0010 決議 10），補抓成功後換成新格式。
-- 擁有者在 FORCE RLS 下沒有政策、更新不到任何列，所以暫時解除 FORCE。同一個交易內做完就恢復。
ALTER TABLE org.sign_task_files NO FORCE ROW LEVEL SECURITY;
UPDATE org.sign_task_files
   SET status = 'failed',
       error = '舊版本機路徑，尚未存進 FileStore，下載時會重新向簽署服務商取得',
       byte_size = NULL,
       content_type = NULL
 WHERE status = 'saved';
ALTER TABLE org.sign_task_files FORCE ROW LEVEL SECURITY;

ALTER TABLE org.sign_task_files DROP COLUMN rel_path;

ALTER TABLE org.sign_task_files
  ADD CONSTRAINT sign_task_files_sha256_format CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  -- key 以 org/<org_id>/ 開頭：組織前綴由資料庫保證，不只靠程式
  ADD CONSTRAINT sign_task_files_key_has_org CHECK (
    object_key IS NULL OR starts_with(object_key, 'org/' || org_id || '/')
  ),
  -- 保存成功的列一定有 key、SHA-256 與大小
  ADD CONSTRAINT sign_task_files_saved_complete CHECK (
    status <> 'saved' OR (object_key IS NOT NULL AND sha256 IS NOT NULL AND byte_size IS NOT NULL)
  );

-- 2. org.outbox ------------------------------------------------------------------------
ALTER TABLE org.outbox DROP CONSTRAINT outbox_action_check;
ALTER TABLE org.outbox
  ADD CONSTRAINT outbox_action_check CHECK (
    action IN ('create_sign_task', 'void_sign_task', 'resend_sign_task', 'save_sign_task_files')
  );
