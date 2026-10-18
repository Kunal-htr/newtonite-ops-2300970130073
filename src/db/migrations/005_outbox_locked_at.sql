-- 005_outbox_locked_at.sql
-- Worker lease: a 'processing' job holds locked_at; the worker reclaims rows
-- whose lease expired (crash recovery, see PROCESSING_TIMEOUT_MS in src/worker.ts).

ALTER TABLE outbox_jobs ADD COLUMN locked_at timestamptz;

CREATE INDEX outbox_jobs_processing_locked_at_idx
  ON outbox_jobs (locked_at)
  WHERE status = 'processing';
