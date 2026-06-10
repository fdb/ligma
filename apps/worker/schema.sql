-- Document metadata. Content lives in R2 at docs/{id}/v{version}.json;
-- this table is what listing, sorting, and (later) a file browser query.
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  current_version INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0
);

-- Anchored comments: pinned to world coordinates on a document's canvas.
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#0ea5e9',
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_doc ON comments(doc_id);
