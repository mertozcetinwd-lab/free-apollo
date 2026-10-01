import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, makeSession, validSession } from '../src/index.js';
import { fakeEnv, client, PW } from './helpers.mjs';

const req = (path, init) => new Request('https://crm.test' + path, init);

test('the API is locked: no cookie, wrong password and a forged cookie are all refused', async () => {
  const env = fakeEnv();
  assert.equal((await handle(req('/api/people'), env)).status, 401);
  assert.equal((await handle(req('/api/login', { method: 'POST', body: '{"password":"nope"}' }), env)).status, 401);
  const forged = String(Date.now() + 86400000) + '.AAAA';
  assert.equal((await handle(req('/api/people', { headers: { cookie: 'crm_session=' + forged } }), env)).status, 401);
});

test('sessions expire and die when the password changes', async () => {
  const s = await makeSession(PW, 1000);
  assert.equal(await validSession(PW, s, 2000), true);
  assert.equal(await validSession(PW, s, 1000 + 31 * 86400000), false);
  assert.equal(await validSession('new password', s, 2000), false);
});

test('ten wrong passwords from one IP trigger a cool-down, even for the right password', async () => {
  const env = fakeEnv();
  const attempt = (password) => handle(req('/api/login', { method: 'POST', headers: { 'cf-connecting-ip': '1.2.3.4' }, body: JSON.stringify({ password }) }), env);
  for (let i = 0; i < 10; i++) assert.equal((await attempt('guess' + i)).status, 401);
  assert.equal((await attempt(PW)).status, 429);
  const other = await handle(req('/api/login', { method: 'POST', headers: { 'cf-connecting-ip': '5.6.7.8' }, body: JSON.stringify({ password: PW }) }), env);
  assert.equal(other.status, 200, 'another IP is not locked out');
});

test('without CRM_PASSWORD the API refuses and says how to fix it', async () => {
  const env = fakeEnv(); delete env.CRM_PASSWORD;
  const r = await handle(req('/api/people'), env);
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /wrangler secret put CRM_PASSWORD/);
});

test('bootstrap returns the default pipeline, views and settings', async () => {
  const api = await client(fakeEnv());
  const { body } = await api.get('/api/bootstrap');
  assert.deepEqual(body.stages.map((s) => s.key), ['lead', 'qualified', 'meeting', 'proposal', 'won', 'lost']);
  assert.equal(body.views.filter((v) => v.object === 'deals').length, 2);
  assert.equal(body.views.find((v) => v.type === 'board').object, 'deals');
  assert.equal(body.settings.theme, 'system');
  assert.ok(Array.isArray(body.settings.lost_reasons));
});

test('people and companies: create, relate, update, and every change lands in the timeline', async () => {
  const env = fakeEnv(); const api = await client(env);
  const co = await api.post('/api/companies', { name: 'Ruiz Roofing', domain: 'https://www.RuizRoofing.example/about' });
  assert.equal(co.status, 201);
  assert.equal(co.body.domain, 'ruizroofing.example', 'domains are normalised');
  const p = await api.post('/api/people', { name: 'Ana Ruiz', email: 'ANA@ruizroofing.example', company_id: co.body.id, tags: 'vip, roofing, vip' });
  assert.equal(p.status, 201);
  assert.equal(p.body.email, 'ana@ruizroofing.example');
  assert.equal(p.body.tags, 'vip, roofing', 'tags are de-duplicated');
  const u = await api.patch(`/api/people/${p.body.id}`, { title: 'Owner', phone: '(352) 555-0100' });
  assert.equal(u.body.title, 'Owner');
  const same = await api.patch(`/api/people/${p.body.id}`, { title: 'Owner' });
  assert.equal(same.status, 200);
  const acts = (await api.get(`/api/activity?type=people&id=${p.body.id}`)).body;
  assert.deepEqual(acts.map((a) => a.kind + ':' + (a.data.field || '')).sort(), ['created:', 'updated:phone', 'updated:title']);
  const coActs = (await api.get(`/api/activity?type=companies&id=${co.body.id}`)).body;
  assert.ok(coActs.some((a) => a.record_type === 'people'), 'a company timeline includes its people');
});

test('validation refuses bad values with a readable message, and relations must exist', async () => {
  const api = await client(fakeEnv());
  const cases = [
    ['/api/people', { name: '  ' }, /Name is required/],
    ['/api/people', { name: 'A', email: 'not-an-email' }, /email/i],
    ['/api/people', { name: 'A', company_id: 999 }, /company does not exist/],
    ['/api/deals', { name: 'D', value_cents: -5 }, /positive/],
    ['/api/deals', { name: 'D', close_date: '10/01/2026' }, /YYYY-MM-DD/],
    ['/api/deals', { name: 'D', stage: 'nope' }, /Unknown stage/],
    ['/api/tasks', { title: 'T', record_type: 'people', record_id: 42 }, /does not exist/],
  ];
  for (const [path, body, re] of cases) {
    const r = await api.post(path, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
});

test('deals: default stage, stage moves stamp the time and log from/to, tasks drive the next-step flag', async () => {
  const api = await client(fakeEnv());
  const d = (await api.post('/api/deals', { name: 'New roof', value_cents: 850000 })).body;
  assert.equal(d.stage, 'lead');
  assert.ok(d.stage_changed_at);
  const moved = (await api.patch(`/api/deals/${d.id}`, { stage: 'proposal' })).body;
  assert.equal(moved.stage, 'proposal');
  const acts = (await api.get(`/api/activity?type=deals&id=${d.id}`)).body;
  const stage = acts.find((a) => a.kind === 'stage');
  assert.deepEqual(stage.data, { from: 'lead', to: 'proposal' });

  let list = (await api.get('/api/deals')).body;
  assert.equal(list[0].open_tasks, 0);
  const t = (await api.post('/api/tasks', { title: 'Send quote', due_date: '2026-10-01', record_type: 'deals', record_id: d.id })).body;
  list = (await api.get('/api/deals')).body;
  assert.equal(list[0].open_tasks, 1);
  assert.equal(list[0].next_due, '2026-10-01');
  const done = (await api.patch(`/api/tasks/${t.id}`, { done: true })).body;
  assert.ok(done.done_at);
  list = (await api.get('/api/deals')).body;
  assert.equal(list[0].open_tasks, 0, 'a finished task no longer counts');
  const dealActs = (await api.get(`/api/activity?type=deals&id=${d.id}`)).body.map((a) => a.kind);
  assert.ok(dealActs.includes('task') && dealActs.includes('task_done'));
});

test('delete is soft, can be undone, and hides the record everywhere', async () => {
  const api = await client(fakeEnv());
  const p = (await api.post('/api/people', { name: 'Jo Park' })).body;
  assert.equal((await api.del(`/api/people/${p.id}`)).status, 200);
  assert.equal((await api.get('/api/people')).body.length, 0);
  assert.equal((await api.get(`/api/people/${p.id}`)).status, 404);
  assert.equal((await api.patch(`/api/people/${p.id}`, { name: 'x' })).status, 404);
  const back = await api.post(`/api/people/${p.id}/restore`);
  assert.equal(back.status, 200);
  assert.equal((await api.get('/api/people')).body.length, 1);
});

test('bulk update and bulk delete', async () => {
  const api = await client(fakeEnv());
  const ids = [];
  for (const n of ['A', 'B', 'C']) ids.push((await api.post('/api/deals', { name: n })).body.id);
  const r = await api.post('/api/deals/bulk', { ids, patch: { stage: 'meeting' } });
  assert.equal(r.body.count, 3);
  assert.ok((await api.get('/api/deals')).body.every((d) => d.stage === 'meeting'));
  await api.post('/api/deals/bulk', { ids: ids.slice(0, 2), action: 'delete' });
  assert.equal((await api.get('/api/deals')).body.length, 1);
});

test('custom fields: create, validate, store in extra, and vanish from rows when deleted', async () => {
  const env = fakeEnv(); const api = await client(env);
  const f = (await api.post('/api/fields', { object: 'companies', label: 'Tier', type: 'select', options: [{ value: 'Gold', color: 'amber' }, { value: 'Silver' }] })).body;
  assert.match(f.key, /^cf_tier_/);
  const bad = await api.post('/api/companies', { name: 'X', [f.key]: 'Bronze' });
  assert.equal(bad.status, 400);
  const co = (await api.post('/api/companies', { name: 'Acme', [f.key]: 'Gold' })).body;
  assert.equal(co.extra[f.key], 'Gold');
  const upd = (await api.patch(`/api/companies/${co.id}`, { [f.key]: 'Silver' })).body;
  assert.equal(upd.extra[f.key], 'Silver');
  await api.del(`/api/fields/${f.id}`);
  const after = (await api.get(`/api/companies/${co.id}`)).body;
  assert.equal(after.extra[f.key], undefined);
});

test('views: create, update config, and the last view of an object cannot be deleted', async () => {
  const api = await client(fakeEnv());
  const v = (await api.post('/api/views', { object: 'people', name: 'VIPs', type: 'table', config: { filters: [{ field: 'tags', op: 'contains', value: 'vip' }] } })).body;
  assert.equal(v.config.filters[0].value, 'vip');
  const u = (await api.patch(`/api/views/${v.id}`, { config: { sort: { field: 'name', dir: 'asc' } } })).body;
  assert.equal(u.config.sort.field, 'name');
  assert.equal((await api.del(`/api/views/${v.id}`)).status, 200);
  const only = (await api.get('/api/bootstrap')).body.views.find((x) => x.object === 'people');
  assert.equal((await api.del(`/api/views/${only.id}`)).status, 409);
});

test('stages: removing a stage that has deals needs a destination, then the deals move', async () => {
  const api = await client(fakeEnv());
  const d = (await api.post('/api/deals', { name: 'D', stage: 'qualified' })).body;
  const next = [{ key: 'lead', name: 'Lead', color: 'gray', kind: 'open' }, { key: 'meeting', name: 'Meeting', color: 'violet', kind: 'open' },
    { name: 'Signed', color: 'green', kind: 'won' }, { key: 'lost', name: 'Lost', color: 'red', kind: 'lost' }];
  const refused = await api.put('/api/stages', { stages: next });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body.needsMove, { qualified: 1 });
  const ok = await api.put('/api/stages', { stages: next, moves: { qualified: 'meeting' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body[2].key, 'signed', 'a new stage gets a key from its name');
  assert.equal((await api.get(`/api/deals/${d.id}`)).body.stage, 'meeting');
  assert.equal((await api.put('/api/stages', { stages: [{ name: 'Won', kind: 'won' }] })).status, 400, 'at least one open stage');
});

test('settings accept only known keys and allowed values', async () => {
  const api = await client(fakeEnv());
  assert.equal((await api.patch('/api/settings', { theme: 'dark', accent: 'violet' })).body.accent, 'violet');
  assert.equal((await api.patch('/api/settings', { theme: 'neon' })).status, 400);
  assert.equal((await api.patch('/api/settings', { admin: true })).status, 400);
});

test('CSV import maps HubSpot / Google headers, creates companies once, keeps notes, reports bad rows', async () => {
  const env = fakeEnv(); const api = await client(env);
  const csv = 'First Name,Last Name,Email Address,Company Name,Job Title,Notes\n' +
    'Jo,Park,jo@park.example,Park HVAC,Owner,met at expo\n' +
    'Sam,Lee,sam@park.example,park hvac,Tech,\n' +
    'Bad,Row,not-an-email,,,\n' +
    ',,,,,\n';
  const r = (await api.post('/api/import/people', csv)).body;
  assert.equal(r.added, 2);
  assert.equal(r.skipped, 1);
  assert.match(r.errors[0], /Row 4/);
  assert.equal(r.companiesCreated, 1, '"Park HVAC" and "park hvac" are one company');
  const people = (await api.get('/api/people')).body;
  assert.equal(new Set(people.map((p) => p.company_id)).size, 1);
  assert.equal(env.sql.prepare('SELECT body FROM notes').get().body, 'met at expo');

  const deals = 'Deal Name,Amount,Deal Stage,Company\nRoof,"$2,500.50",Proposal,Park HVAC\nGutter,100,Nonsense,New Co\n';
  const d = (await api.post('/api/import/deals', deals)).body;
  assert.equal(d.added, 2);
  const rows = (await api.get('/api/deals')).body;
  const roof = rows.find((x) => x.name === 'Roof');
  assert.equal(roof.value_cents, 250050);
  assert.equal(roof.stage, 'proposal');
  assert.equal(rows.find((x) => x.name === 'Gutter').stage, 'lead', 'an unknown stage falls back to the first open stage');
});

test('CSV export shows names instead of ids and cannot smuggle a spreadsheet formula', async () => {
  const api = await client(fakeEnv());
  const co = (await api.post('/api/companies', { name: 'A, B' })).body;
  await api.post('/api/deals', { name: '=HYPERLINK("http://x")', company_id: co.id, value_cents: 123456, stage: 'won' });
  const text = (await api.get('/api/export/deals.csv')).body;
  assert.match(text, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  assert.match(text, /"A, B"/);
  assert.match(text, /1234\.56/);
  assert.match(text, /,Won,/);
});

test('the danger zone needs the word DELETE', async () => {
  const api = await client(fakeEnv());
  await api.post('/api/people', { name: 'X' });
  assert.equal((await api.del('/api/data', { confirm: 'yes' })).status, 400);
  assert.equal((await api.del('/api/data', { confirm: 'DELETE' })).status, 200);
  assert.equal((await api.get('/api/people')).body.length, 0);
  assert.equal((await api.get('/api/bootstrap')).body.stages.length, 6, 'settings and pipeline survive');
});
