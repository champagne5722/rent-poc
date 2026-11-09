-- org.outbox.action 的 CHECK 取兩條線動作的聯集（E 線同步 C 線，MIL-120 與 MIL-87）。
-- 由 runner 以 app_owner 執行。
--
-- 0008（A 線 MIL-87）加了 save_sign_task_files。0053（E 線 MIL-120）重設清單時只含 send_email，
-- 在兩條線合併後的執行順序下會蓋掉 save_sign_task_files，文件保存的 outbox 列會被 CHECK 擋下。
-- 0053 已在 E 線執行過，不能改，所以用這支補齊。
--
-- 之後任何票新增動作，都用新的 migration 重設這個 CHECK，清單必須是目前所有動作的聯集，
-- 並同步更新 src/lib/signing-module/outbox.ts 的 OUTBOX_ACTIONS。
ALTER TABLE org.outbox DROP CONSTRAINT outbox_action_check;
ALTER TABLE org.outbox ADD CONSTRAINT outbox_action_check
  CHECK (action IN (
    'create_sign_task',
    'void_sign_task',
    'resend_sign_task',
    'save_sign_task_files',
    'send_email'
  ));
