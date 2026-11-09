-- employment_exclusivity_facts 只回專任判定用得到的別家任職（MIL-165）。
-- 由 runner 以 app_owner 執行。只用 CREATE OR REPLACE，簽名、授權與 0047 相同。
--
-- 0047 的版本回傳同一證書鍵在所有執業主體的任職，含已失效與待驗證的，連同起訖日。
-- 呼叫條件只有「呼叫者是某個執業主體組織的成員」。證書鍵由種類、年、字、序號組成，可以枚舉，
-- 所以任何執業主體組織的成員都能探測別人的任職歷史，與查不存在的證書鍵可區分。函式註解寫「不能探測」，程式碼沒做到。
--
-- 判定函式 decideEmploymentCreation（src/lib/registry-rules/exclusivity.ts）對「別家」只用一件事：
-- 有沒有一筆狀態是 verified、任職期間涵蓋今天的任職。待驗證與已失效的別家任職不影響判定。
-- 所以別家（other）只回狀態是 verified 的列，起訖日留給呼叫端比對今天。自己這家（self）照舊全部回傳。
-- 已驗證代表進行中，任職結束時轉已失效（0047），所以結束的任職不會出現在 other。
--
-- 沒有加「呼叫者必須持有這個證書鍵」的條件。registerCertificate 在寫任何東西之前就判定專任（P0-05 AC1、AC6），
-- 那時呼叫者還沒有這個證書鍵的證書列，加了條件，第一次登錄就不再被阻擋。
-- 殘餘風險：任何執業主體組織的成員，仍能從 other 的有無得知某個證書鍵在別家有已驗證在職。
-- 這與登錄時的阻擋結果揭露的資訊相同（ADR-0017 決議 7），但直接呼叫函式沒有稽核紀錄與審核項目。

CREATE OR REPLACE FUNCTION registry.employment_exclusivity_facts(p_certificate_key text)
RETURNS TABLE (whose text, state text, started_on text, ended_on text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org    text := nullif(current_setting('app.org_id', true), '');
  v_entity text;
BEGIN
  PERFORM registry.assert_practice_member();
  SELECT e.id INTO v_entity FROM registry.practice_entities e WHERE e.org_id = v_org;
  RETURN QUERY
  SELECT CASE WHEN m.entity_id = v_entity THEN 'self' ELSE 'other' END, m.state, m.started_on::text, m.ended_on::text
    FROM registry.practitioner_employments m
   WHERE m.certificate_key = p_certificate_key
     AND (m.entity_id = v_entity OR m.state = 'verified');
END
$$;
