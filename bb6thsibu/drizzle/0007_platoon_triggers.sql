-- Platoon 的数据库保护：不可删除（只能停用 / 作废），所属组别不可改
CREATE TRIGGER platoons_no_delete BEFORE DELETE ON platoons FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER platoon_activities_no_delete BEFORE DELETE ON platoon_activities FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER platoon_scores_no_delete BEFORE DELETE ON platoon_scores FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_platoon_section() RETURNS trigger AS $$
BEGIN
  IF NEW.section_id IS DISTINCT FROM OLD.section_id THEN
    RAISE EXCEPTION 'platoons.section_id cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER platoons_protect_section BEFORE UPDATE ON platoons FOR EACH ROW EXECUTE FUNCTION protect_platoon_section();
--> statement-breakpoint
-- 作废后的活动不能再改（只能看）
CREATE OR REPLACE FUNCTION guard_voided_activity() RETURNS trigger AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'A voided activity cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER platoon_activities_guard_void BEFORE UPDATE ON platoon_activities FOR EACH ROW EXECUTE FUNCTION guard_voided_activity();
