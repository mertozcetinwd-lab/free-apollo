/** Prepare a local D1 database and ignored local password. No remote calls or deployment. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dry = process.argv.includes('--dry');
const say = (s) => process.stdout.write(s + '\n');

function run(bin, args) {
  if (dry) { say(`Would run ${bin} ${args.join(' ')}`); return; }
  const command = process.platform === 'win32' ? `${bin}.cmd` : bin;
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  if (result.status !== 0) throw new Error(`${bin} ${args.slice(0, 2).join(' ')} failed`);
}

function localSecret(key) {
  const file = root + '.env';
  if (!existsSync(file)) return null;
  const match = readFileSync(file, 'utf8').match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'));
  const value = match?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (value && !/[\r\n]/.test(value)) return value;
  return null;
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Use Node.js 22.13 or newer');
  say('Free Apollo local setup');
  if (!existsSync(root + 'node_modules/wrangler')) run('npm', ['install']);
  const password = localSecret('CRM_PASSWORD') || 'preview';
  const providerToken = localSecret('TREG_TOKEN');
  const osmContact = localSecret('NOMINATIM_CONTACT_EMAIL');
  if (!dry) writeFileSync(root + '.dev.vars', `CRM_PASSWORD=${JSON.stringify(password)}\n${providerToken ? `TREG_TOKEN=${JSON.stringify(providerToken)}\n` : ''}${osmContact ? `NOMINATIM_CONTACT_EMAIL=${JSON.stringify(osmContact)}\n` : ''}`, { mode: 0o600 });
  say(localSecret('CRM_PASSWORD') ? 'Local password loaded from your ignored .env.' : 'Using the preview password for this local-only setup.');
  if (providerToken) say('Optional provider token loaded from your ignored .env.');
  if (osmContact) say('Public place lookup contact loaded from your ignored .env.');
  run('npx', ['wrangler', 'd1', 'execute', 'free-apollo', '--local', '--file', 'schema.sql']);
  say(dry ? 'Dry run complete. No files or database were changed.' : 'Local database ready. Run npm run dev, then open the printed URL.');
  say('No Cloudflare account, remote database, paid provider or deployment was touched.');
} catch (error) {
  process.stderr.write(`Setup stopped: ${error.message}\n`);
  process.exitCode = 1;
}
