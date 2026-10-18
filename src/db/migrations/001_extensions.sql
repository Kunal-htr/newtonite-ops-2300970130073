-- 001_extensions.sql
-- Required for the GIN trigram index on work_items.title
-- (SYSTEM_DESIGN.md "Indexes" #5 - search).

CREATE EXTENSION IF NOT EXISTS pg_trgm;
