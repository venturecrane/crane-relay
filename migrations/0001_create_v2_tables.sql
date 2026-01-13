-- Phase 1: event store (append-only, idempotent)
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  role TEXT NOT NULL,
  agent TEXT NOT NULL,
  environment TEXT,
  overall_verdict TEXT,
  created_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_repo_issue_created ON events(repo, issue_number, created_at);

-- Phase 1: rolling status comment mapping
CREATE TABLE IF NOT EXISTS relay_status_comment (
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  comment_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, issue_number)
);

-- Phase 2: evidence index
CREATE TABLE IF NOT EXISTS evidence_assets (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  event_id TEXT,
  filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_repo_issue ON evidence_assets(repo, issue_number);
