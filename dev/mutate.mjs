/** Plant one behavioral bug at a time and require the prospect tests to fail. */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const prospect = root + 'src/prospect.js';
const discovery = root + 'src/discovery.js';
const drafts = root + 'src/drafts.js';
const mutations = [
  [prospect, 'records.length > 5', 'records.length > 500', 'transfer batch limit'],
  [prospect, "lower(email)=?1 AND deleted_at IS NULL", "lower(email)=?1 AND 0 AND deleted_at IS NULL", 'email deduplication'],
  [prospect, "kind === 'people' && !email", "kind === 'people' && false", 'missing email refuses transfer'],
  [prospect, "at ? 'observed' : 'unknown'", "at ? 'verified' : 'unknown'", 'transfer does not invent verification'],
  [prospect, "at ? 'observed' : 'unknown'", "at ? 'observed' : 'observed'", 'missing observation stays unknown'],
  [prospect, 'delay_value < 0', 'false', 'negative sequence delay'],
  [prospect, 'sending_enabled: false', 'sending_enabled: true', 'planning never sends'],
  [prospect, "if (results.length !== new Set(ids).size) fail(400, 'A selected record was not found');", "if (false) fail(400, 'A selected record was not found');", 'list member must exist'],
  [discovery, 'cap > limit', 'cap > limit + 1000', 'provider cap enforcement'],
  [discovery, "input?.approved !== true", 'false', 'provider requires approval'],
  [discovery, "verified ? 'verified' : 'unknown'", "'verified'", 'risky email remains unknown'],
  [discovery, 'el?.tags?.[area.key] === area.value', 'true', 'local search checks business category'],
  [discovery, 'if (charged === null || !Number.isSafeInteger(charged))', 'if (false)', 'missing provider charge is not free'],
  [prospect, "status=CASE WHEN excluded.status='unknown' THEN prospect_evidence.status ELSE excluded.status END",
    'status=excluded.status', 'missing date cannot erase observed evidence'],
  [drafts, "'{{source-backed observation about the company}}'", "'This company misses many calls'", 'draft needs source or placeholder'],
  [drafts, 'row.detail === `Value at observation: ${value}`', 'true', 'edited value cannot borrow an old citation'],
];
const run = () => spawnSync(process.execPath, ['--test', 'test/prospect.test.mjs', 'test/discovery.test.mjs', 'test/drafts.test.mjs'],
  { cwd: root, encoding: 'utf8', timeout: 30_000 });
if (run().status !== 0) { process.stderr.write('Tests fail before mutation.\n'); process.exit(1); }
let caught = 0;
for (const [file, from, to, name] of mutations) {
  const original = readFileSync(file, 'utf8');
  if (!original.includes(from)) { process.stderr.write(`Missing mutation pattern: ${name}\n`); process.exitCode = 1; continue; }
  writeFileSync(file, original.replace(from, to));
  try {
    const result = run();
    if (result.status !== 0) { caught++; process.stdout.write(`caught: ${name}\n`); }
    else { process.stderr.write(`MISSED: ${name}\n`); process.exitCode = 1; }
  } finally { writeFileSync(file, original); }
}
process.stdout.write(`${caught}/${mutations.length} mutations caught.\n`);
