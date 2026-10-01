/** Add missing local tables and sequence columns without touching saved records. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
if (!existsSync(wrangler)) throw new Error('Run npm install first');

function run(args, json = false) {
  const result = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'free-apollo', '--local',
    ...(json ? ['--json'] : []), ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Local D1 command failed');
  if (!json) return;
  const output = JSON.parse(result.stdout);
  if (!output?.[0]?.success) throw new Error('Local D1 query failed');
  return output[0].results;
}

const quoted = (name) => `'${name.replaceAll("'", "''")}'`;
const hasTable = (name) => run(['--command', `SELECT name FROM sqlite_master WHERE type='table' AND name=${quoted(name)}`], true).length > 0;
const hasColumn = (table, column) => run(['--command', `SELECT name FROM pragma_table_info(${quoted(table)}) WHERE name=${quoted(column)}`], true).length > 0;
const apply = (file) => { run(['--file', `migrations/${file}`]); process.stdout.write(`Applied ${file}\n`); };

if (!hasTable('prospect_sequences')) apply('0001_prospect.sql');
if (!hasTable('prospect_searches') || !hasTable('prospect_search_saved')) apply('0002_discovery.sql');
if (!hasColumn('prospect_sequences', 'schedule')) {
  run(['--command', `ALTER TABLE prospect_sequences ADD COLUMN schedule TEXT NOT NULL DEFAULT '{"days":[1,2,3,4,5],"start":"08:00","end":"17:00","timezone":"local"}'`]);
  process.stdout.write('Added sequence schedule\n');
}
if (!hasColumn('prospect_sequences', 'rules')) {
  run(['--command', `ALTER TABLE prospect_sequences ADD COLUMN rules TEXT NOT NULL DEFAULT '{"stop_on_reply":true,"stop_on_meeting":true,"pause_on_ooo":true,"bounce_guard":true,"daily_cap":50}'`]);
  process.stdout.write('Added sequence rules\n');
}
if (!hasTable('prospect_geocodes') || !hasTable('prospect_source_rate')) apply('0004_local_discovery.sql');
if (!hasTable('prospect_search_locks')) apply('0005_search_locks.sql');
process.stdout.write('Local Free Apollo database is current.\n');
