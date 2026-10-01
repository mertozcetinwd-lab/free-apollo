CREATE TABLE IF NOT EXISTS prospect_geocodes (
  place TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prospect_source_rate (
  source TEXT PRIMARY KEY,
  next_at_ms INTEGER NOT NULL
);
