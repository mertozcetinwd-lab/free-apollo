-- Free CRM v2 schema (Cloudflare D1 / SQLite). Safe to run more than once.
-- Apply locally:  npx wrangler d1 execute free-crm --local  --file schema.sql
-- Apply live:     npx wrangler d1 execute free-crm --remote --file schema.sql
--
-- Design notes
-- * Money is integer cents. Dates are 'YYYY-MM-DD'; timestamps are ISO-8601 UTC strings.
-- * Custom fields added in Settings live in each row's `extra` JSON, so adding a field never needs
--   a migration.
-- * Deletes are soft (deleted_at) so the toast can offer Undo; rows deleted more than 30 days ago
--   are purged the next time something is deleted.

CREATE TABLE IF NOT EXISTS companies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  domain      TEXT,
  industry    TEXT,
  employees   REAL,
  phone       TEXT,
  city        TEXT,
  tags        TEXT,
  extra       TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE TABLE IF NOT EXISTS people (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  title       TEXT,
  company_id  INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  city        TEXT,
  linkedin    TEXT,
  source      TEXT,
  tags        TEXT,
  extra       TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_people_company ON people(company_id);

CREATE TABLE IF NOT EXISTS deals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  value_cents       INTEGER NOT NULL DEFAULT 0,
  stage             TEXT NOT NULL,
  stage_changed_at  TEXT NOT NULL,           -- drives "days in stage" on the board
  company_id        INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  person_id         INTEGER REFERENCES people(id) ON DELETE SET NULL,
  close_date        TEXT,
  source            TEXT,
  lost_reason       TEXT,
  extra             TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_id);

-- Tasks and notes attach to any record through (record_type, record_id).
CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  due_date     TEXT,
  done_at      TEXT,
  record_type  TEXT,
  record_id    INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_record ON tasks(record_type, record_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);

CREATE TABLE IF NOT EXISTS notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT,
  body         TEXT,
  record_type  TEXT,
  record_id    INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_record ON notes(record_type, record_id);

-- Every change, as data. The record timeline and the home feed render these as sentences.
CREATE TABLE IF NOT EXISTS activity (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  record_type  TEXT NOT NULL,
  record_id    INTEGER NOT NULL,
  kind         TEXT NOT NULL,     -- created, updated, stage, deleted, restored, note, task, task_done
  label        TEXT,              -- the record's name at the time, so the feed survives deletes
  data         TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_record ON activity(record_type, record_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_time ON activity(created_at);

CREATE TABLE IF NOT EXISTS stages (
  key       TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  color     TEXT NOT NULL DEFAULT 'gray',
  kind      TEXT NOT NULL DEFAULT 'open' CHECK (kind IN ('open', 'won', 'lost')),
  position  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fields (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  object    TEXT NOT NULL,
  key       TEXT NOT NULL,
  label     TEXT NOT NULL,
  type      TEXT NOT NULL,
  options   TEXT NOT NULL DEFAULT '[]',
  position  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (object, key)
);

CREATE TABLE IF NOT EXISTS views (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  object    TEXT NOT NULL,
  name      TEXT NOT NULL,
  type      TEXT NOT NULL DEFAULT 'table' CHECK (type IN ('table', 'board')),
  config    TEXT NOT NULL DEFAULT '{}',
  position  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Wrong-password attempts per IP, so the one password cannot be guessed at speed.
CREATE TABLE IF NOT EXISTS login_failures (
  ip  TEXT NOT NULL,
  at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_failures ON login_failures(ip, at);

-- Defaults. INSERT OR IGNORE / WHERE NOT EXISTS keep a re-run from duplicating them.
INSERT OR IGNORE INTO stages (key, name, color, kind, position) VALUES
  ('lead', 'Lead', 'gray', 'open', 0),
  ('qualified', 'Qualified', 'blue', 'open', 1),
  ('meeting', 'Meeting', 'violet', 'open', 2),
  ('proposal', 'Proposal', 'amber', 'open', 3),
  ('won', 'Won', 'green', 'won', 4),
  ('lost', 'Lost', 'red', 'lost', 5);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('theme', '"system"'),
  ('accent', '"mono"'),
  ('currency', '"USD"'),
  ('date_format', '"mdy"'),
  ('week_start', '"sunday"'),
  ('record_open', '"panel"'),
  ('lost_reasons', '["Price","Timing","Chose a competitor","No response"]');

INSERT INTO views (object, name, type, config, position)
  SELECT 'people', 'All people', 'table', '{"columns":["name","company_id","title","email","phone","tags"]}', 0
  WHERE NOT EXISTS (SELECT 1 FROM views WHERE object = 'people');
INSERT INTO views (object, name, type, config, position)
  SELECT 'companies', 'All companies', 'table', '{"columns":["name","domain","industry","employees","city","tags"]}', 0
  WHERE NOT EXISTS (SELECT 1 FROM views WHERE object = 'companies');
INSERT INTO views (object, name, type, config, position)
  SELECT 'deals', 'Pipeline', 'board', '{"cardFields":["company_id","value_cents","close_date"]}', 0
  WHERE NOT EXISTS (SELECT 1 FROM views WHERE object = 'deals');
INSERT INTO views (object, name, type, config, position)
  SELECT 'deals', 'All deals', 'table', '{"columns":["name","stage","value_cents","company_id","person_id","close_date"],"calcs":{"value_cents":"sum"}}', 1
  WHERE (SELECT count(*) FROM views WHERE object = 'deals') = 1;

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
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  schedule TEXT NOT NULL DEFAULT '{"days":[1,2,3,4,5],"start":"08:00","end":"17:00","timezone":"local"}',
  rules TEXT NOT NULL DEFAULT '{"stop_on_reply":true,"stop_on_meeting":true,"pause_on_ooo":true,"bounce_guard":true,"daily_cap":50}'
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

-- Free Apollo discovery works in this database. No Free Clay service or database is required.
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
CREATE TABLE IF NOT EXISTS prospect_search_locks (
  search_key TEXT PRIMARY KEY,
  locked_until TEXT NOT NULL
);
