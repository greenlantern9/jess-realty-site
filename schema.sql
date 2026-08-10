-- Lead pipeline for jessicakortum.com
--
-- You do NOT need to run this by hand: worker.js creates the table (and adds
-- newer columns) on demand the first time a query finds them missing. This is
-- kept as the readable reference for what the shape is.
--
-- Manual apply, if ever needed:
--   wrangler d1 execute jess-realty-leads --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS leads (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL DEFAULT '',
  phone           TEXT,
  intent          TEXT,
  message         TEXT,                          -- what they typed on the site
  status          TEXT NOT NULL DEFAULT 'new',   -- pipeline stage
  notes           TEXT NOT NULL DEFAULT '',      -- free-form private notes
  source          TEXT NOT NULL DEFAULT 'website',
  priority        TEXT NOT NULL DEFAULT 'warm',  -- hot | warm | cold
  tags            TEXT NOT NULL DEFAULT '',      -- comma separated
  next_follow_up  TEXT NOT NULL DEFAULT '',      -- YYYY-MM-DD
  budget          INTEGER NOT NULL DEFAULT 0,    -- whole dollars, 0 = unknown
  activity        TEXT NOT NULL DEFAULT '[]',    -- JSON [{at,type,text}], newest first
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
