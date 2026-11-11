-- 物件列表依物件分組（MIL-202）。由 runner 以 app_owner 執行。
--
-- 合併單位時，registry 只在被合併的單位寫 status 與 merged_into_id，單位自己的 anchor_id 不變（ADR-0013 決議 8）。
-- 所以 registry.get_anchors_for_units 對被合併的單位回的仍是它原本的錨點，用錨點分組會把
-- 被合併的單位與存續單位分在兩筆。這個函式沿 merged_into_id 走到存續單位，再沿錨點的 merged_into_id
-- 走到存續錨點，回「單位對存續單位與分組鍵」，讓呼叫端用分組鍵歸組、用存續單位去除重複。
--
-- 誰能呼叫：app_rw。回傳：p_unit_ids 之中，呼叫者組織有 org.properties 指向的單位。
-- 別的組織的單位 ID 與不存在的 ID 得到空結果。寫法同 get_unit_details 的 EXISTS 條件。
-- 回傳的 survivor_key 與 group_key 是存續單位與存續錨點 ID 的 md5。存續單位可能屬於別的組織，
-- 所以不回原始 ID：呼叫端只能拿來比對相同或不同，拿不到登記庫的 ID。
CREATE FUNCTION registry.get_unit_groups(p_unit_ids text[])
RETURNS TABLE (
  unit_id      text,
  survivor_key text,
  group_key    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
  WITH RECURSIVE chain (origin, id, merged_into_id, depth) AS (
    SELECT u.id, u.id, u.merged_into_id, 0
      FROM registry.rental_units u
     WHERE u.id = ANY (p_unit_ids)
       AND EXISTS (SELECT 1 FROM org.properties p WHERE p.rental_unit_id = u.id)
    UNION ALL
    SELECT c.origin, n.id, n.merged_into_id, c.depth + 1
      FROM chain c
      JOIN registry.rental_units n ON n.id = c.merged_into_id
     WHERE c.depth < 10
  ),
  survivor AS (
    SELECT DISTINCT ON (origin) origin, id FROM chain ORDER BY origin, depth DESC
  ),
  anchor_chain (origin, id, merged_into_id, depth) AS (
    SELECT s.origin, a.id, a.merged_into_id, 0
      FROM survivor s
      JOIN registry.rental_units su ON su.id = s.id
      JOIN registry.anchors a       ON a.id = su.anchor_id
    UNION ALL
    SELECT c.origin, n.id, n.merged_into_id, c.depth + 1
      FROM anchor_chain c
      JOIN registry.anchors n ON n.id = c.merged_into_id
     WHERE c.depth < 10
  ),
  anchor_survivor AS (
    SELECT DISTINCT ON (origin) origin, id FROM anchor_chain ORDER BY origin, depth DESC
  )
  SELECT s.origin, md5(s.id), md5(x.id)
    FROM survivor s
    JOIN anchor_survivor x ON x.origin = s.origin
$$;

REVOKE ALL ON FUNCTION registry.get_unit_groups(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.get_unit_groups(text[]) TO app_rw;
