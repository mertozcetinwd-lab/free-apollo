import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

test('prospecting migration preserves an existing CRM database', () => {
  const db = new DatabaseSync(':memory:');
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/0001_prospect.sql', import.meta.url), 'utf8');
  const marker = '-- Prospecting adds no sending path.';
  assert.ok(schema.includes(marker));
  db.exec(schema.split(marker)[0]);
  db.prepare(`INSERT INTO companies(name,domain,created_at,updated_at) VALUES ('Sample Workshop','sample.example','2026-09-30','2026-09-30')`).run();
  db.exec(migration);
  db.exec(migration);
  assert.equal(db.prepare('SELECT count(*) AS n FROM companies').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM prospect_sequences').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM prospect_lists').get().n, 0);
  db.close();
});

test('discovery migration preserves existing prospect records', () => {
  const db = new DatabaseSync(':memory:');
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/0002_discovery.sql', import.meta.url), 'utf8');
  db.exec(schema.split('-- Free Apollo discovery works in this database.')[0]);
  db.prepare(`INSERT INTO prospect_sequences(name,description,steps,status,created_at,updated_at)
    VALUES ('Sample sequence','','[]','draft','2026-09-30','2026-09-30')`).run();
  db.exec(migration); db.exec(migration);
  assert.equal(db.prepare('SELECT count(*) AS n FROM prospect_sequences').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM prospect_searches').get().n, 0);
  db.close();
});

test('sequence controls migration keeps old draft steps', () => {
  const db = new DatabaseSync(':memory:');
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/0003_sequence_controls.sql', import.meta.url), 'utf8');
  const old = schema.replace(/,\r?\n  schedule TEXT NOT NULL DEFAULT '[^']*',\r?\n  rules TEXT NOT NULL DEFAULT '[^']*'/, '');
  assert.notEqual(old, schema, 'The old-shape fixture must omit the new columns');
  db.exec(old);
  db.prepare(`INSERT INTO prospect_sequences(name,description,steps,status,created_at,updated_at)
    VALUES ('Sample draft','','[{"type":"email_draft","delay_days":0,"subject":"Hi","body":"Review"}]','draft','2026-09-30','2026-09-30')`).run();
  db.exec(migration);
  const row = db.prepare('SELECT steps,schedule,rules FROM prospect_sequences').get();
  assert.equal(JSON.parse(row.steps)[0].subject, 'Hi');
  assert.deepEqual(JSON.parse(row.schedule).days, [1, 2, 3, 4, 5]);
  assert.equal(JSON.parse(row.rules).bounce_guard, true);
  db.close();
});

test('local source and search-lock migrations keep saved records', () => {
  const db = new DatabaseSync(':memory:');
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  db.exec(schema.split('CREATE TABLE IF NOT EXISTS prospect_geocodes')[0]);
  db.prepare(`INSERT INTO companies(name,domain,created_at,updated_at)
    VALUES ('Sample Workshop','sample.example','2026-09-30','2026-09-30')`).run();
  db.exec(readFileSync(new URL('../migrations/0004_local_discovery.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0005_search_locks.sql', import.meta.url), 'utf8'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM companies').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM prospect_geocodes').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM prospect_search_locks').get().n, 0);
  db.close();
});
