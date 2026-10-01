/** Capture documentation screenshots from a local database containing only sample data. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const out = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const chrome = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome',
  '/usr/bin/chromium'].find((path) => path && existsSync(path));
if (!chrome) throw new Error('Chrome or Edge is needed to capture screenshots');
const raw = readFileSync(root + '.dev.vars', 'utf8').match(/^CRM_PASSWORD=(.*)$/m)?.[1]?.trim();
if (!raw) throw new Error('Start a local preview after npm run setup');
const password = raw.startsWith('"') ? JSON.parse(raw) : raw;
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password }) });
if (!login.ok) throw new Error('Local preview login failed');
const session = login.headers.get('set-cookie')?.match(/crm_session=([^;]+)/)?.[1];
if (!session) throw new Error('No local preview session');
const auth = { cookie: `crm_session=${session}` };
for (const [route, expected] of [['companies', 3], ['people', 1], ['prospect/sequences', 1]]) {
  const res = await fetch(base + '/api/' + route, { headers: auth });
  if (!res.ok) throw new Error(`Could not check ${route}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length !== expected) throw new Error('Use the three-company fictional preview database only');
  if (route === 'companies' && !rows.every((row) => /^(Sample|Example) /.test(row.name) && row.domain.endsWith('.example.com')))
    throw new Error('A company is not fictional sample data');
  if (route === 'people' && !rows.every((row) => row.name === 'Sample Owner' && row.email.endsWith('.example.com')))
    throw new Error('A person is not fictional sample data');
  if (route === 'prospect/sequences' && !rows.every((row) => row.name === 'Sample owner review' && row.planned === 0))
    throw new Error('A sequence is not the fictional draft');
}

const port = 9400 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), 'free-apollo-shots-'));
const browser = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
let socket, serial = 0;
const pending = new Map();
try {
  for (let i = 0; i < 50 && !socket; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((item) => item.type === 'page');
      if (page) socket = new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* browser is starting */ }
    if (!socket) await pause(200);
  }
  if (!socket) throw new Error('Headless browser did not start');
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    message.error ? task.fail(new Error(message.error.message)) : task.done(message.result);
  };
  const send = (method, params = {}) => new Promise((done, fail) => {
    const id = ++serial;
    pending.set(id, { done, fail });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Network.enable');
  await send('Runtime.enable');
  await send('Network.setCookie', { name: 'crm_session', value: decodeURIComponent(session), url: base });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  mkdirSync(out, { recursive: true });
  for (const [name, path] of [['workspace', '/'], ['find-leads', '/prospect/discover'],
    ['companies', '/companies'], ['sequences', '/prospect/sequences'],
    ['sequence-editor', '/prospect/sequences'], ['message-draft', '/prospect/draft']]) {
    await send('Page.navigate', { url: base + path });
    await pause(1800);
    if (name === 'sequence-editor') {
      const result = await send('Runtime.evaluate', { expression: `(() => {
        const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Edit');
        if (!button) throw new Error('No sample sequence editor');
        button.click();
      })()`, returnByValue: true });
      if (result.exceptionDetails) throw new Error('Could not open sample sequence editor');
      await pause(500);
    }
    if (name === 'message-draft') {
      const result = await send('Runtime.evaluate', { expression: `(() => {
        const company = document.querySelector('select[name="company_id"]');
        const offer = document.querySelector('input[name="offer"]');
        const form = company?.closest('form');
        if (!form || !company.options[1]) throw new Error('No sample company for draft');
        company.value = company.options[1].value;
        company.dispatchEvent(new Event('change', { bubbles: true }));
        offer.value = 'a missed-call AI voice agent';
        offer.dispatchEvent(new Event('input', { bubbles: true }));
        form.requestSubmit();
      })()`, returnByValue: true });
      if (result.exceptionDetails) throw new Error('Could not preview sample draft');
      await pause(900);
    }
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(out, name + '.png'), Buffer.from(data, 'base64'));
    process.stdout.write(`Captured ${name}.png\n`);
  }
} finally {
  socket?.close();
  browser.kill();
  await pause(500);
  const temp = resolve(tmpdir()) + sep;
  if (resolve(profile).startsWith(temp) && profile.includes('free-apollo-shots-'))
    rmSync(profile, { recursive: true, force: true });
}
