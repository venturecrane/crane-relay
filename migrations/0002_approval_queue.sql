-- Phase 3: approval queue for pending QA results
CREATE TABLE IF NOT EXISTS approval_queue (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  pr_number INTEGER,
  commit_sha TEXT,
  agent TEXT NOT NULL,
  verdict TEXT NOT NULL,
  summary TEXT,
  scope_results TEXT,
  evidence_urls TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_queue_status ON approval_queue(status);
CREATE INDEX IF NOT EXISTS idx_approval_queue_repo ON approval_queue(repo);
CREATE INDEX IF NOT EXISTS idx_approval_queue_created ON approval_queue(created_at);
