-- Free Apollo's own search cache, sources and capped provider calls.
CREATE TABLE IF NOT EXISTS prospect_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('people','companies')),
  source TEXT NOT NULL,
  query TEXT NOT NULL,
  results TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  cost_micros INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prospect_searches_recent ON prospect_searches(kind,source,observed_at DESC);
CREATE TABLE IF NOT EXISTS prospect_search_saved (
  search_id INTEGER NOT NULL REFERENCES prospect_searches(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('people','companies')),
  record_id INTEGER NOT NULL,
  PRIMARY KEY(search_id,item_index)
);
