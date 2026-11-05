-- 数据库层面的完整性保护（程序有 bug 时的最后一道防线）

-- ─── 1. 主资料禁止删除（只能停用） ─────────────────────
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Deleting from % is not allowed; deactivate instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER users_no_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER sections_no_delete BEFORE DELETE ON sections FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER ranks_no_delete BEFORE DELETE ON ranks FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER roles_no_delete BEFORE DELETE ON roles FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER inactive_reasons_no_delete BEFORE DELETE ON inactive_reasons FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER permissions_no_delete BEFORE DELETE ON permissions FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER rank_history_no_delete BEFORE DELETE ON rank_history FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint

-- ─── 2. 审计日志只能新增 ─────────────────────────────
CREATE OR REPLACE FUNCTION forbid_audit_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_change();
--> statement-breakpoint

-- ─── 3. 系统军阶（system_key）不可改名、换组别、停用或更改标记 ───
CREATE OR REPLACE FUNCTION protect_system_rank() RETURNS trigger AS $$
BEGIN
  IF NEW.system_key IS DISTINCT FROM OLD.system_key THEN
    RAISE EXCEPTION 'ranks.system_key cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.system_key IS NOT NULL AND (
       NEW.name IS DISTINCT FROM OLD.name
    OR NEW.section_id IS DISTINCT FROM OLD.section_id
    OR NEW.is_active IS DISTINCT FROM OLD.is_active
  ) THEN
    RAISE EXCEPTION 'System rank % cannot be renamed, moved or deactivated', OLD.name
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ranks_protect_system BEFORE UPDATE ON ranks FOR EACH ROW EXECUTE FUNCTION protect_system_rank();
--> statement-breakpoint

-- ─── 4. Captain 规则 ─────────────────────────────────
-- 持有 system_key = 'captain' 军阶的用户就是 Captain。
-- * 全系统最多一位
-- * Captain 必须是 active
-- * 只有在事务中设定 app.captain_change = 'on'（初始化 / 交接流程）才能授予或移除 Captain 军阶
CREATE OR REPLACE FUNCTION enforce_captain_rules() RETURNS trigger AS $$
DECLARE
  captain_rank smallint;
  privileged boolean := coalesce(current_setting('app.captain_change', true), '') = 'on';
BEGIN
  SELECT id INTO captain_rank FROM ranks WHERE system_key = 'captain';
  IF captain_rank IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.rank_id = captain_rank AND NOT privileged THEN
      RAISE EXCEPTION 'Captain rank can only be assigned through setup or succession'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.rank_id IS DISTINCT FROM OLD.rank_id
        AND (NEW.rank_id = captain_rank OR OLD.rank_id = captain_rank)
        AND NOT privileged THEN
    RAISE EXCEPTION 'Captain rank can only be changed through setup or succession'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.rank_id = captain_rank THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'The current Captain cannot be deactivated' USING ERRCODE = 'check_violation';
    END IF;
    -- 串行化并发的 Captain 变更，避免同时出现两位
    PERFORM pg_advisory_xact_lock(hashtext('bb6_single_captain'));
    IF EXISTS (SELECT 1 FROM users WHERE rank_id = captain_rank AND id <> NEW.id) THEN
      RAISE EXCEPTION 'There can only be one Captain' USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER users_captain_rules BEFORE INSERT OR UPDATE OF rank_id, status ON users
  FOR EACH ROW EXECUTE FUNCTION enforce_captain_rules();
