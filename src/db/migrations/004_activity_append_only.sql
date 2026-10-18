-- 004_activity_append_only.sql
-- "Append-only: a trigger raises on UPDATE and DELETE"
-- (SYSTEM_DESIGN.md "Database Schema" - activity_events).

CREATE FUNCTION activity_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'activity_events is append-only; % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER trg_activity_events_append_only
  BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION activity_events_append_only();
