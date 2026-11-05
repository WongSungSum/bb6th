-- 作废活动的分数不能再新增或修改（服务层已挡，数据库再保护一次）
CREATE OR REPLACE FUNCTION guard_voided_score() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM platoon_activities a WHERE a.id = NEW.activity_id AND a.voided_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Scores of a voided activity cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER platoon_scores_guard_void BEFORE INSERT OR UPDATE ON platoon_scores FOR EACH ROW EXECUTE FUNCTION guard_voided_score();
