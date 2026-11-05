-- 第二阶段：权限管理与组织维护的数据库保护

-- ─── 1. 系统组别 Officer：标记后不可改名、停用或更改标记 ───
UPDATE sections SET system_key = 'officer' WHERE name = 'Officer' AND system_key IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_system_section() RETURNS trigger AS $$
BEGIN
  IF OLD.system_key IS NOT NULL AND NEW.system_key IS DISTINCT FROM OLD.system_key THEN
    RAISE EXCEPTION 'sections.system_key cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.system_key IS NOT NULL AND (NEW.name IS DISTINCT FROM OLD.name OR NEW.is_active IS DISTINCT FROM OLD.is_active) THEN
    RAISE EXCEPTION 'System section % cannot be renamed or deactivated', OLD.name USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER sections_protect_system BEFORE UPDATE ON sections FOR EACH ROW EXECUTE FUNCTION protect_system_section();
--> statement-breakpoint

-- ─── 2. 权限变更申请：不可删除；只能从 pending 变成已决定一次，内容不可改 ───
CREATE TRIGGER permission_change_requests_no_delete BEFORE DELETE ON permission_change_requests FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_change_request() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'A decided request cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.changes IS DISTINCT FROM OLD.changes OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'Request content cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  -- 申请人不能批准自己的申请
  IF NEW.status = 'approved' AND NEW.decided_by = OLD.requested_by THEN
    RAISE EXCEPTION 'A request cannot be approved by its requester' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER permission_change_requests_guard BEFORE UPDATE ON permission_change_requests FOR EACH ROW EXECUTE FUNCTION guard_change_request();
