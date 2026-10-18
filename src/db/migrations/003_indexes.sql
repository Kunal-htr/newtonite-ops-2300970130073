-- 003_indexes.sql
-- The seven indexes from SYSTEM_DESIGN.md "Indexes".

-- 1. Filtered list + keyset pagination
CREATE INDEX work_items_team_status_created_idx
  ON work_items (team_id, status, created_at DESC, id DESC);

-- 2. "Assigned to me"
CREATE INDEX work_items_assignee_active_idx
  ON work_items (assignee_id, updated_at DESC)
  WHERE status <> 'CLOSED';

-- 3. "Unassigned urgent"
CREATE INDEX work_items_unassigned_urgent_idx
  ON work_items (team_id, created_at DESC)
  WHERE assignee_id IS NULL AND priority = 'urgent' AND status IN ('OPEN', 'IN_PROGRESS');

-- 4. Approvals ("Awaiting my approval")
CREATE INDEX work_items_awaiting_approval_idx
  ON work_items (team_id, updated_at DESC)
  WHERE status = 'AWAITING_APPROVAL';

-- 5. GIN trigram search on title
CREATE INDEX work_items_title_trgm_idx
  ON work_items USING gin (title gin_trgm_ops);

-- 6. Activity timeline
CREATE INDEX activity_events_item_timeline_idx
  ON activity_events (item_id, id DESC);

-- 7. Worker poll
CREATE INDEX outbox_jobs_pending_run_at_idx
  ON outbox_jobs (run_at)
  WHERE status = 'pending';
