-- Prospecting adds no sending path. Every sequence is a draft and every enrollment is a plan.
CREATE TABLE IF NOT EXISTS prospect_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('people','companies')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prospect_list_members (
  list_id INTEGER NOT NULL REFERENCES prospect_lists(id) ON DELETE CASCADE,
  record_id INTEGER NOT NULL, PRIMARY KEY(list_id, record_id)
);
CREATE INDEX IF NOT EXISTS idx_prospect_members_record ON prospect_list_members(record_id);
CREATE TABLE IF NOT EXISTS prospect_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('people','companies')),
  record_id INTEGER NOT NULL, field TEXT NOT NULL, source TEXT NOT NULL, source_url TEXT,
  observed_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('observed','verified','unknown','error')),
  detail TEXT, UNIQUE(kind,record_id,field,source)
);
CREATE INDEX IF NOT EXISTS idx_prospect_evidence_record ON prospect_evidence(kind,record_id);
CREATE TABLE IF NOT EXISTS prospect_sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft' CHECK(status='draft'),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prospect_enrollments (
  sequence_id INTEGER NOT NULL REFERENCES prospect_sequences(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','paused','complete')),
  created_at TEXT NOT NULL, PRIMARY KEY(sequence_id,person_id)
);
CREATE TABLE IF NOT EXISTS prospect_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, action TEXT NOT NULL,
  cap_micros INTEGER NOT NULL, charged_micros INTEGER NOT NULL, outcome TEXT NOT NULL,
  detail TEXT, created_at TEXT NOT NULL
);
