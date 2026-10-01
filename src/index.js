/**
 * Free Apollo: one Cloudflare Worker + one D1 database.
 *
 * The Worker answers /api/* itself; every other path is the app in /public (a single-page app, so
 * unknown paths fall back to index.html, see wrangler.toml).
 */

import { json, readJson, fail, HttpError, nowIso } from './util.js';
import { sameText, makeSession, validSession, readCookie, sessionCookie, CLEAR_COOKIE } from './auth.js';
import {
  listRecords, getRecord, createRecord, updateRecord, deleteRecord, restoreRecord, bulk,
  listActivity, importCsv, exportCsv, assertObject,
} from './records.js';
import {
  bootstrap, patchSettings, createView, updateView, deleteView, replaceStages,
  createField, updateField, deleteField, wipeData,
} from './meta.js';
import { overview, lists, createList, listMembers, changeMembers, sequences, saveSequence,
  planSequence, plannedPeople, setPlanState, evidence, transferBatch, costs } from './prospect.js';
import { SOURCES, searchCompanies, geocodePlace, searchLocalCompanies, searchPeople, recentSearches,
  getSearch, saveSearchResults, enrichPerson } from './discovery.js';
import { draftFirstMessage } from './drafts.js';

export { makeSession, validSession } from './auth.js';

const MAX_FAILURES = 10;            // wrong passwords per IP ...
const FAILURE_WINDOW_MIN = 15;      // ... per 15 minutes, then a cool-down

const id = (s) => { const n = Number(s); if (!Number.isInteger(n) || n <= 0) fail(400, 'Bad id'); return n; };

async function login(request, env, url) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const since = new Date(Date.now() - FAILURE_WINDOW_MIN * 60000).toISOString();
  const recent = await env.DB.prepare('SELECT count(*) AS n FROM login_failures WHERE ip=?1 AND at>?2').bind(ip, since).first();
  if ((recent?.n || 0) >= MAX_FAILURES) return json({ error: `Too many attempts. Try again in ${FAILURE_WINDOW_MIN} minutes.` }, 429);
  const { password } = await readJson(request);
  if (!sameText(password || '', env.CRM_PASSWORD)) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO login_failures (ip, at) VALUES (?1, ?2)').bind(ip, nowIso()),
      env.DB.prepare('DELETE FROM login_failures WHERE at < ?1').bind(since),
    ]);
    return json({ error: 'Wrong password' }, 401);
  }
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(await makeSession(env.CRM_PASSWORD), url.protocol === 'https:') });
}

async function route(request, env, url) {
  const db = env.DB;
  const m = request.method;
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const [a, b, c] = parts;

  if (a === 'prospect') {
    if (b === 'sources' && m === 'GET') return json(SOURCES);
    if (b === 'searches' && m === 'GET') return json(await recentSearches(db));
    if (b === 'search' && c === 'companies' && m === 'POST') return json(await searchCompanies(db, await readJson(request)));
    if (b === 'search' && c === 'place' && m === 'POST') return json(await geocodePlace(db, env, await readJson(request)));
    if (b === 'search' && c === 'local' && m === 'POST') return json(await searchLocalCompanies(db, await readJson(request)));
    if (b === 'search' && c === 'people' && m === 'POST') return json(await searchPeople(env, await readJson(request)));
    if (b === 'search' && c === 'save' && m === 'POST') return json(await saveSearchResults(db, await readJson(request)));
    if (b === 'search' && c && m === 'GET') return json(await getSearch(db, c));
    if (b === 'enrich' && c === 'person' && m === 'POST') return json(await enrichPerson(env, await readJson(request)));
    if (b === 'draft' && m === 'POST') return json(await draftFirstMessage(db, await readJson(request)));
    if (b === 'overview' && m === 'GET') return json(await overview(db));
    if (b === 'costs' && m === 'GET') return json(await costs(db));
    if (b === 'transfer' && m === 'POST') return json(await transferBatch(db, await readJson(request)));
    if (b === 'evidence' && c && parts[3] && m === 'GET') return json(await evidence(db, c, parts[3]));
    if (b === 'lists') {
      if (!c && m === 'GET') return json(await lists(db, url.searchParams.get('kind')));
      if (!c && m === 'POST') return json(await createList(db, await readJson(request)), 201);
      if (c && parts[3] === 'members' && m === 'GET') return json(await listMembers(db, c));
      if (c && parts[3] === 'members' && m === 'POST') return json(await changeMembers(db, c, await readJson(request)));
      if (c && parts[3] === 'members' && m === 'DELETE') return json(await changeMembers(db, c, await readJson(request), true));
    }
    if (b === 'sequences') {
      if (!c && m === 'GET') return json(await sequences(db));
      if (!c && m === 'POST') return json(await saveSequence(db, await readJson(request)), 201);
      if (c && !parts[3] && m === 'PUT') return json(await saveSequence(db, await readJson(request), c));
      if (c && parts[3] === 'plan' && !parts[4] && m === 'GET') return json(await plannedPeople(db, c));
      if (c && parts[3] === 'plan' && m === 'POST') return json(await planSequence(db, c, await readJson(request)));
      if (c && parts[3] === 'plan' && parts[4] && m === 'PATCH') return json(await setPlanState(db, c, parts[4], await readJson(request)));
    }
    return json({ error: 'Not found' }, 404);
  }

  if (a === 'bootstrap' && m === 'GET') return json(await bootstrap(db));
  if (a === 'settings' && m === 'PATCH') return json(await patchSettings(db, await readJson(request)));
  if (a === 'activity' && m === 'GET') {
    return json(await listActivity(db, { type: url.searchParams.get('type'), id: url.searchParams.get('id'), limit: url.searchParams.get('limit') }));
  }

  if (a === 'views') {
    if (!b && m === 'POST') return json(await createView(db, await readJson(request)), 201);
    if (b && m === 'PATCH') return json(await updateView(db, id(b), await readJson(request)));
    if (b && m === 'DELETE') return json(await deleteView(db, id(b)));
  }
  if (a === 'stages' && m === 'PUT') return json(await replaceStages(db, await readJson(request)));
  if (a === 'fields') {
    if (!b && m === 'POST') return json(await createField(db, await readJson(request)), 201);
    if (b && m === 'PATCH') return json(await updateField(db, id(b), await readJson(request)));
    if (b && m === 'DELETE') return json(await deleteField(db, id(b)));
  }
  if (a === 'data' && m === 'DELETE') return json(await wipeData(db, await readJson(request)));

  if (a === 'import' && b && m === 'POST') {
    const text = await request.text();
    if (text.length > 10_000_000) fail(413, 'That file is over 10 MB');
    return json(await importCsv(db, b, text));
  }
  if (a === 'export' && b && m === 'GET') {
    const object = b.replace(/\.csv$/, '');
    return new Response(await exportCsv(db, object), { headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${object}-${nowIso().slice(0, 10)}.csv"`,
    } });
  }

  if (a && !b) {
    assertObject(a);
    if (m === 'GET') return json(await listRecords(db, a));
    if (m === 'POST') return json(await createRecord(db, a, await readJson(request)), 201);
  }
  if (a && b === 'bulk' && m === 'POST') return json(await bulk(db, a, await readJson(request)));
  if (a && b && !c) {
    const rid = id(b);
    if (m === 'GET') return json(await getRecord(db, a, rid));
    if (m === 'PATCH') return json(await updateRecord(db, a, rid, await readJson(request)));
    if (m === 'DELETE') return json(await deleteRecord(db, a, rid));
  }
  if (a && b && c === 'restore' && m === 'POST') return json(await restoreRecord(db, a, id(b)));
  return json({ error: 'Not found' }, 404);
}

export async function handle(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) {
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  }
  if (!env.CRM_PASSWORD) return json({ error: 'CRM_PASSWORD is not set. Run: npx wrangler secret put CRM_PASSWORD' }, 500);
  try {
    if (url.pathname === '/api/login' && request.method === 'POST') return await login(request, env, url);
    if (url.pathname === '/api/logout' && request.method === 'POST') return json({ ok: true }, 200, { 'set-cookie': CLEAR_COOKIE });
    if (!(await validSession(env.CRM_PASSWORD, readCookie(request, 'crm_session')))) return json({ error: 'Login required' }, 401);
    if (url.pathname === '/api/me') return json({ ok: true });
    return await route(request, env, url);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
    return json({ error: 'Server error: ' + String(e?.message || e).slice(0, 200) }, 500);
  }
}

export default { fetch: handle };
