CREATE TABLE IF NOT EXISTS prospect_search_locks (
  search_key TEXT PRIMARY KEY,
  locked_until TEXT NOT NULL
);
