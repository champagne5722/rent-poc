-- 合約與合約歷程（MIL-83，ADR-0012、ADR-0006、ADR-0007）。
-- 由 runner 以 app_owner 執行。寫法照 0003：org_id、複合唯一鍵、ENABLE 與 FORCE RLS、legacy_id。
--
-- 簽署任務（sign_tasks、signers、sign_task_files）不在這裡，屬 MIL-85。
-- 過渡期它們仍在 SQLite，以合約的 ULID 當 subject_id。

-- 1. org.contracts：合約 -------------------------------------------------------
CREATE TABLE org.contracts (
  id               text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id           text NOT NULL REFERENCES control.orgs (id),
  -- 物件的 ULID。可為空：複合外鍵在任一欄為空時不檢查（MATCH SIMPLE）。route 建約時一定帶值
  property_id      text,
  -- 合約類型（ADR-0021 決議 2）：決定簽章分流的文件類型
  contract_type    text NOT NULL DEFAULT 'lease' CHECK (contract_type IN ('lease', 'management')),
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'awaiting_tenant', 'awaiting_practitioner', 'awaiting_landlord',
                                       'completed', 'declined', 'voided')),
  -- 欄位快照。含分流條件 fields.routing（MIL-67）、範本綁定與條款快照、設備附件
  fields           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(fields) = 'object'),
  signature_fields jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(signature_fields) = 'array'),
  declined_reason  text,
  -- 衍生自哪份合約（ADR-0006）：只有「撤回後複製為新草稿」記錄，拒簽後的複製為空
  derived_from     text,
  -- 舊 SQLite 的 id，只供遷移對照，切換穩定 2 週後移除（ADR-0012 決議 9，MIL-93）
  legacy_id        integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz,
  UNIQUE (org_id, id),
  UNIQUE (org_id, legacy_id),
  -- 複合外鍵（ADR-0012 陷阱 5）：外鍵檢查不受 RLS 限制，只有帶 org_id 才擋得住跨組織引用。
  -- 預設的 NO ACTION 讓「有合約的物件不能刪」成立（ADR-0025 決議 14）
  FOREIGN KEY (org_id, property_id) REFERENCES org.properties (org_id, id),
  FOREIGN KEY (org_id, derived_from) REFERENCES org.contracts (org_id, id),
  CHECK (derived_from IS NULL OR derived_from <> id)
);

CREATE INDEX contracts_org_created ON org.contracts (org_id, id DESC);
CREATE INDEX contracts_property ON org.contracts (org_id, property_id);
CREATE INDEX contracts_derived_from ON org.contracts (org_id, derived_from) WHERE derived_from IS NOT NULL;

ALTER TABLE org.contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.contracts
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- 2. org.contract_events：合約歷程 -------------------------------------------------
-- append-only（ADR-0007）：app_rw 只有 SELECT 與 INSERT。草稿刪除時歷程隨合約走，
-- 由外鍵的 ON DELETE CASCADE 刪除（外鍵動作以表擁有者的權限執行，不需要 app_rw 有 DELETE）。
CREATE TABLE org.contract_events (
  id          text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id      text NOT NULL REFERENCES control.orgs (id),
  contract_id text NOT NULL,
  type        text NOT NULL CHECK (type IN ('created', 'sent', 'tenant_signed', 'signer_signed',
                                            'declined', 'completed', 'voided', 'copied')),
  actor       text NOT NULL CHECK (actor IN ('landlord', 'tenant', 'system', 'party_a', 'party_b', 'practitioner')),
  note        text,
  legacy_id   integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, legacy_id),
  FOREIGN KEY (org_id, contract_id) REFERENCES org.contracts (org_id, id) ON DELETE CASCADE
);

CREATE INDEX contract_events_by_contract ON org.contract_events (org_id, contract_id, id);

REVOKE UPDATE, DELETE, TRUNCATE ON org.contract_events FROM app_rw;

ALTER TABLE org.contract_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.contract_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.contract_events
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
