-- users.id / account_type / created_by 建立后不可更改（保护「唯一 Superadmin」）
CREATE OR REPLACE FUNCTION protect_user_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.account_type IS DISTINCT FROM OLD.account_type
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'users.id, account_type and created_by cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER users_protect_identity BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION protect_user_identity();
--> statement-breakpoint
-- 军阶历史只能新增
CREATE OR REPLACE FUNCTION forbid_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER rank_history_no_update BEFORE UPDATE ON rank_history FOR EACH ROW EXECUTE FUNCTION forbid_update();
