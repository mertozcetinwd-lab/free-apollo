/**
 * Standalone discovery for Free Apollo. Free company search uses public Wikidata.
 * People lookup and email operations use an optional owner-supplied treg token.
 * Nothing runs from an import or page load. A paid request needs an explicit cap
 * and the provider receives that cap in X-Treg-Route-Max-Cost.
 */
import { fail, nowIso, parseJson } from './util.js';
import { createRecord, updateRecord } from './records.js';
import { checkArea, inCircle, LOCAL_CATEGORIES, AreaError, MAX_RESULTS } from '../public/js/overpass.js';

const DAY = 86_400_000;
const STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
const text = (v, n = 200) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
const domain = (v) => {
  const d = text(v, 300).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(d) ? d : null;
};
const pick = (obj, ...keys) => keys.map((key) => obj?.[key]).find((value) => value !== undefined && value !== null && value !== '') || '';
const workEmail = (value) => {
  const email = text(value, 320).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return '';
  const [local, host] = email.split('@');
  if (/^(you|yourname|first\.last|firstname\.lastname|test|example|noreply|no-reply)$/.test(local)
    || /^(example\.(com|org|net)|test\.com|yourcompany\.com)$/.test(host)) return '';
  return email;
};
const idOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : fail(400, 'Bad id'); };
const asMoney = (n) => '$' + (n / 1e6).toFixed(3);

export const SOURCES = [
  { id: 'osm_local', kind: 'companies', class: 'free public', label: 'OpenStreetMap local businesses', cap_micros: 0,
    note: 'Place lookup plus a category search. Shared public servers may be busy; results need review.' },
  { id: 'wikidata', kind: 'companies', class: 'free public', label: 'Wikidata companies', cap_micros: 0,
    note: 'Industry and optional US state. Public data is uneven and needs review.' },
  { id: 'company_site', kind: 'people', class: 'free public', label: 'Company website people', cap_micros: 0,
    note: 'Read one chosen company page. Structured Person entries or a user-entered name and nearby role become candidates.' },
  { id: 'treg_people', kind: 'people', class: 'paid BYOK', label: 'People by title and company', cap_micros: 100_000,
    note: 'Optional treg token. A search can cost up to $0.10; the actual charge is logged.' },
  { id: 'treg_email_find', kind: 'people', class: 'paid BYOK', label: 'Find work email', cap_micros: 20_000,
    note: 'Optional treg token. A found email is not yet verified.' },
  { id: 'treg_email_verify', kind: 'people', class: 'paid BYOK', label: 'Verify work email', cap_micros: 10_000,
    note: 'Optional treg token. Catch-all and uncertain results stay unverified.' },
];

export { LOCAL_CATEGORIES };

export async function geocodePlace(db, env, input, fetcher = globalThis.fetch.bind(globalThis)) {
  const place = text(input?.place, 120);
  if (!/^[\p{L}\p{N} .,'-]{3,120}$/u.test(place)) fail(400, 'Enter a city and state, such as Gainesville, FL');
  const key = place.toLowerCase();
  const old = await db.prepare('SELECT result FROM prospect_geocodes WHERE place=?1 AND expires_at>?2')
    .bind(key, nowIso()).first();
  if (old) return { ...parseJson(old.result, {}), cached: true };
  const contact = text(env.NOMINATIM_CONTACT_EMAIL, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact))
    fail(400, 'Set NOMINATIM_CONTACT_EMAIL before using public place lookup');
  const now = Date.now();
  const slot = await db.prepare(`INSERT INTO prospect_source_rate(source,next_at_ms) VALUES ('nominatim',?1)
    ON CONFLICT(source) DO UPDATE SET next_at_ms=excluded.next_at_ms
    WHERE prospect_source_rate.next_at_ms<=?2 RETURNING next_at_ms`).bind(now + 1000, now).first();
  if (!slot) fail(429, 'Public place lookup is cooling down. Retry in a moment.');
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(place);
  let res;
  try { res = await fetcher(url, { headers: { accept: 'application/json',
    'user-agent': `FreeApollo/1.0 (contact: ${contact})` } }); }
  catch { fail(503, 'Place lookup could not be reached. Retry later.'); }
  if (!res.ok) fail(502, `Place lookup returned ${res.status}. Retry later.`);
  let data;
  try { data = await res.json(); } catch { fail(502, 'Place lookup returned unreadable data. Retry later.'); }
  const first = Array.isArray(data) ? data[0] : null;
  const lat = Number(first?.lat), lon = Number(first?.lon);
  if (!first || !(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180))
    fail(404, 'That place was not found by this source. Try a more specific city and state.');
  const result = { lat, lon, name: text(first.display_name, 300) || place };
  await db.prepare(`INSERT INTO prospect_geocodes(place,result,observed_at,expires_at) VALUES (?1,?2,?3,?4)
    ON CONFLICT(place) DO UPDATE SET result=excluded.result,observed_at=excluded.observed_at,expires_at=excluded.expires_at`)
    .bind(key, JSON.stringify(result), nowIso(), new Date(Date.now() + 30 * DAY).toISOString()).run();
  return { ...result, cached: false };
}

function osmBusiness(el) {
  if (!el || !['node', 'way', 'relation'].includes(el.type) || !Number.isInteger(el.id) || el.id <= 0
    || !el.tags || typeof el.tags !== 'object') return null;
  const tags = Object.fromEntries(Object.entries(el.tags).filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => [k, text(v, 300)]));
  if (!tags.name) return null;
  const lat = Number(el.lat ?? el.center?.lat), lon = Number(el.lon ?? el.center?.lon);
  const website = tags.website || tags['contact:website'];
  return { name: tags.name, domain: domain(website), phone: text(tags.phone || tags['contact:phone'], 100),
    city: text(tags['addr:city'], 120), lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    industry: text(tags.craft || tags.shop || tags.amenity || tags.office || tags.leisure, 100),
    source_url: `https://www.openstreetmap.org/${el.type}/${el.id}` };
}

export async function searchLocalCompanies(db, input) {
  let area;
  try { area = checkArea(input); } catch (e) { if (e instanceof AreaError) fail(400, e.message); throw e; }
  if (!Array.isArray(input?.elements) || input.elements.length > 1000) fail(400, 'Provide up to 1000 map results');
  const q = { ...area, category: text(input.category, 40) };
  const results = inCircle(area, input.elements.filter((el) => el?.tags?.[area.key] === area.value)
    .map(osmBusiness).filter(Boolean)).slice(0, MAX_RESULTS);
  return store(db, 'companies', 'osm_local', q, results);
}

function companyQuery(input) {
  const industry = text(input?.industry, 60).toLowerCase();
  const state = text(input?.state, 2).toUpperCase();
  if (!/^[\p{L}\p{N} &'.,-]{2,60}$/u.test(industry)) fail(400, 'Enter an industry, such as software');
  if (state && !STATES.has(state)) fail(400, 'Choose a US state or all states');
  return { industry, state };
}

function sparql(q) {
  const place = q.state
    ? `?c wdt:P159 ?hq . ?st wdt:P300 "US-${q.state}" . ?hq wdt:P131* ?st .`
    : '?c wdt:P17 wd:Q30 .';
  return `SELECT ?c ?cLabel ?site ?emp ?indLabel WHERE {
    SERVICE wikibase:mwapi { bd:serviceParam wikibase:api "EntitySearch"; wikibase:endpoint "www.wikidata.org";
      mwapi:search ${JSON.stringify(q.industry)}; mwapi:language "en"; mwapi:limit "10". ?ind wikibase:apiOutputItem mwapi:item. }
    ?c wdt:P452 ?ind . ${place}
    FILTER NOT EXISTS { ?c wdt:P576 ?dissolved }
    OPTIONAL { ?c wdt:P856 ?site } OPTIONAL { ?c wdt:P1128 ?emp }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  } LIMIT 100`;
}

export function parseWikidata(json) {
  const companies = new Map();
  for (const b of json?.results?.bindings || []) {
    const rawUrl = b.c?.value || '';
    if (!/^http:\/\/www\.wikidata\.org\/entity\/Q\d+$/.test(rawUrl)) continue;
    const name = text(b.cLabel?.value, 300);
    if (!name || /^Q\d+$/.test(name)) continue;
    const url = rawUrl.replace('http://', 'https://');
    const site = text(b.site?.value, 500);
    const d = domain(site);
    const employees = Number(b.emp?.value);
    const prior = companies.get(url);
    companies.set(url, { name, domain: prior?.domain || d, industry: prior?.industry || text(b.indLabel?.value),
      employees: Number.isFinite(employees) && employees > 0 ? Math.round(employees) : prior?.employees || null,
      source_url: url });
  }
  return [...companies.values()];
}

async function cached(db, kind, source, query) {
  const row = await db.prepare(`SELECT * FROM prospect_searches WHERE kind=?1 AND source=?2 AND query=?3 AND expires_at>?4
    ORDER BY id DESC LIMIT 1`).bind(kind, source, JSON.stringify(query), nowIso()).first();
  return row && { id: row.id, kind, source, query, results: parseJson(row.results, []), observed_at: row.observed_at,
    cost_micros: 0, cached: true };
}

async function store(db, kind, source, query, results, cost = 0) {
  const at = nowIso(), expires = new Date(Date.now() + 7 * DAY).toISOString();
  const row = await db.prepare(`INSERT INTO prospect_searches(kind,source,query,results,observed_at,expires_at,cost_micros)
    VALUES (?1,?2,?3,?4,?5,?6,?7) RETURNING id`).bind(kind, source, JSON.stringify(query), JSON.stringify(results), at, expires, cost).first();
  return { id: row.id, kind, source, query, results, observed_at: at, cost_micros: cost, cached: false };
}

const personRole = (value) => text(value, 200);
const personName = (value) => text(value, 300);
const hasType = (node, type) => [node?.['@type']].flat().some((v) => String(v).toLowerCase().split('/').pop() === type);

/** Only explicit, labelled Person entries are candidates. Page text is never guessed into a person. */
export function parseCompanySitePeople(html, sourceUrl, companyDomain) {
  const entries = [];
  const scripts = String(html).match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script\s*>/gi) || [];
  for (const script of scripts.slice(0, 30)) {
    const raw = script.replace(/^<script\b[^>]*>/i, '').replace(/<\/script\s*>$/i, '').trim();
    let json;
    try { json = JSON.parse(raw); } catch { continue; }
    const visit = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 5) return;
      if (Array.isArray(node)) { node.forEach((item) => visit(item, depth + 1)); return; }
      if (hasType(node, 'person')) {
        const name = personName(node.name), title = personRole(node.jobTitle || node.roleName);
        if (name && title && /\b(owner|founder|co-founder|cofounder|president|chief executive|ceo)\b/i.test(title))
          entries.push({ name, title, domain: companyDomain, source_url: sourceUrl });
      }
      for (const key of ['@graph', 'employee', 'founder', 'member', 'author']) visit(node[key], depth + 1);
    };
    visit(json);
  }
  return [...new Map(entries.map((row) => [`${row.name.toLowerCase()}|${row.title.toLowerCase()}`, row])).values()].slice(0, 25);
}

function pageText(html) {
  return String(html).replace(/<!--[^]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[^]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#(?:x[0-9a-f]+|\d+)|amp|quot|apos|nbsp|lt|gt);/gi, (_, entity) => {
      const named = { amp: '&', quot: '"', apos: "'", nbsp: ' ', lt: '<', gt: '>' };
      const lower = entity.toLowerCase();
      if (named[lower]) return named[lower];
      const n = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : Number(lower.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
    }).replace(/\s+/g, ' ').trim();
}

/** A user-guided candidate needs both the exact name and a nearby role on the chosen page. */
function guidedPerson(html, name, title, sourceUrl, companyDomain) {
  if (!name && !title) return null;
  if (!/^[\p{L}][\p{L}'’-]*(?: [\p{L}][\p{L}'’-]*){1,3}$/u.test(name)
    || !/\b(owner|founder|co-founder|cofounder|president|chief executive|ceo)\b/i.test(title))
    fail(400, 'Enter a full name and an owner or founder role shown on the page');
  const body = pageText(html).toLowerCase();
  const person = name.toLowerCase(), role = title.toLowerCase();
  const rolePattern = /\bfounder\b/.test(role) ? /\b(founder|founded)\b/
    : /\bowner\b/.test(role) ? /\b(owner|owned)\b/ : null;
  let from = 0, matched = false;
  while ((from = body.indexOf(person, from)) !== -1) {
    const nearby = body.slice(Math.max(0, from - 220), Math.min(body.length, from + person.length + 220));
    if (nearby.includes(role) || rolePattern?.test(nearby)) { matched = true; break; }
    from += person.length;
  }
  if (!matched) fail(422, 'That name and role were not found together on this page. Check the source or try another page.');
  return { name, title, domain: companyDomain, source_url: sourceUrl };
}

async function readCompanyHtml(response) {
  const reader = response.body?.getReader();
  if (!reader) fail(502, 'Company page had no readable body.');
  const decoder = new TextDecoder();
  let bytes = 0, html = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 500_000) { await reader.cancel(); fail(413, 'Company page is over the 500 KB reading limit.'); }
    html += decoder.decode(chunk.value, { stream: true });
  }
  return html + decoder.decode();
}

export async function searchCompanySitePeople(db, input, fetcher = globalThis.fetch.bind(globalThis)) {
  const companyId = idOf(input?.company_id);
  const company = await db.prepare('SELECT id,name,domain FROM companies WHERE id=?1 AND deleted_at IS NULL').bind(companyId).first();
  if (!company?.domain || !domain(company.domain)) fail(400, 'Save a company with a valid website domain first');
  let url;
  try { url = new URL(String(input?.url || '')); } catch { fail(400, 'Enter a full HTTPS page URL'); }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const root = domain(company.domain);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !['', '443'].includes(url.port)
    || (host !== root && !host.endsWith('.' + root)) || !/^[a-z0-9.-]+$/.test(host)
    || url.href.length > 1000 || /^(localhost|.*\.local|.*\.internal)$/.test(host))
    fail(400, 'Use an HTTPS page on the saved company domain');
  url.hash = '';
  const name = personName(input?.name), title = personRole(input?.title);
  const query = { company_id: companyId, url: url.href, name, title };
  const old = await cached(db, 'people', 'company_site', query);
  if (old) return old;
  let response;
  try { response = await fetcher(url.href, { redirect: 'manual', headers: { accept: 'text/html', 'user-agent': 'FreeApollo/1.0 (user-requested company page)' }, signal: AbortSignal.timeout(12_000) }); }
  catch { fail(503, 'Company page could not be reached. Retry or enter another page.'); }
  if (response.status >= 300 && response.status < 400) fail(502, 'Company page redirected. Enter its final HTTPS URL on the same domain.');
  if (!response.ok) fail(502, `Company page returned ${response.status}. Retry or enter another page.`);
  if (!(response.headers.get('content-type') || '').toLowerCase().includes('text/html')) fail(502, 'Company page did not return HTML.');
  if (Number(response.headers.get('content-length') || 0) > 500_000) fail(413, 'Company page is over the 500 KB reading limit.');
  const html = await readCompanyHtml(response);
  const results = parseCompanySitePeople(html, url.href, root);
  const guided = guidedPerson(html, name, title, url.href, root);
  if (guided && !results.some((r) => r.name.toLowerCase() === guided.name.toLowerCase())) results.unshift(guided);
  return store(db, 'people', 'company_site', query, results.slice(0, 25));
}

export async function searchCompanies(db, input, fetcher = globalThis.fetch.bind(globalThis)) {
  const q = companyQuery(input);
  const old = await cached(db, 'companies', 'wikidata', q);
  if (old) return old;
  const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparql(q));
  let res;
  try { res = await fetcher(url, { headers: { accept: 'application/sparql-results+json', 'user-agent': 'FreeApollo/1.0 (public company search)' } }); }
  catch { fail(503, 'Wikidata could not be reached. Retry later.'); }
  if (!res.ok) fail(res.status === 429 ? 503 : 502, `Wikidata returned ${res.status}. Retry or narrow the industry.`);
  let data;
  try { data = await res.json(); } catch { fail(502, 'Wikidata returned unreadable data. Retry later.'); }
  return store(db, 'companies', 'wikidata', q, parseWikidata(data));
}

function capOf(input, limit) {
  const cap = Number(input?.max_micros);
  if (!Number.isInteger(cap) || cap < 1 || cap > limit) fail(400, `Set a maximum cost from $0.000001 to ${asMoney(limit)}`);
  if (input?.approved !== true) fail(400, `Confirm the maximum cost of ${asMoney(cap)} before running`);
  return cap;
}

async function ledger(db, action, cap, charged, outcome) {
  await db.prepare(`INSERT INTO prospect_costs(provider,action,cap_micros,charged_micros,outcome,detail,created_at)
    VALUES ('treg',?1,?2,?3,?4,'',?5)`).bind(action, cap, charged, outcome, nowIso()).run();
}

async function treg(env, action, body, cap, fetcher) {
  if (!env.TREG_TOKEN) fail(400, 'TREG_TOKEN is not configured');
  let res;
  try { res = await fetcher(`https://treg.to/call/${action}`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-treg-token': env.TREG_TOKEN,
    'x-treg-route-max-cost': (cap / 1e6).toFixed(6), 'user-agent': 'free-apollo/1.0',
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(25_000) }); }
  catch { await ledger(env.DB, action, cap, 0, 'unknown_retry'); fail(503, 'Provider connection failed. Check its usage before retrying.'); }
  const rawCharge = res.headers.get('x-treg-cost-micro');
  const charged = rawCharge !== null && /^\d+$/.test(rawCharge) ? Number(rawCharge) : null;
  if (charged === null || !Number.isSafeInteger(charged)) {
    await ledger(env.DB, action, cap, 0, 'charge_unknown');
    fail(502, 'Provider did not report a usable charge. Check its usage before retrying.');
  }
  if (charged > cap) { await ledger(env.DB, action, cap, charged, 'over_cap'); fail(502, 'Provider reported a charge above the cap. Stop and review the ledger.'); }
  if (!res.ok) {
    await ledger(env.DB, action, cap, charged, 'error_retry');
    fail(res.status === 402 ? 402 : 502, `Provider returned ${res.status}. Check its usage before retrying.`);
  }
  let output;
  try { const json = await res.json(); output = json.output && typeof json.output === 'object' ? json.output : {}; }
  catch { await ledger(env.DB, action, cap, charged, 'error_retry'); fail(502, 'Provider data was unreadable. Check its usage before retrying.'); }
  await ledger(env.DB, action, cap, charged, 'done');
  return { output, charged };
}

export async function searchPeople(env, input, fetcher = globalThis.fetch.bind(globalThis)) {
  const q = { title: text(input?.title, 100), company_domain: input?.company_domain ? domain(input.company_domain) : '',
    location: text(input?.location, 80), limit: Math.min(25, Math.max(1, Number(input?.limit) || 10)) };
  if (!q.title && !q.company_domain) fail(400, 'Enter a job title or company domain');
  if (input?.company_domain && !q.company_domain) fail(400, 'Company domain looks wrong');
  const old = await cached(env.DB, 'people', 'treg_people', q);
  if (old) return old;
  const cap = capOf(input, 100_000);
  return paidLock(env.DB, `people:${JSON.stringify(q)}`, async () => {
    const repeat = await cached(env.DB, 'people', 'treg_people', q);
    if (repeat) return repeat;
    const { output, charged } = await treg(env, 'treg.people.search', q, cap, fetcher);
    const people = (Array.isArray(output.people) ? output.people : []).slice(0, q.limit).map((p) => {
    const name = text(pick(p, 'full_name', 'name') || [pick(p, 'first_name', 'firstname'),
      pick(p, 'last_name', 'lastname')].filter(Boolean).join(' '), 300);
    return { name, title: text(pick(p, 'title', 'job_title', 'headline', 'position')),
      company: text(pick(p, 'company', 'company_name', 'organization', 'organization_name', 'employer')),
      domain: domain(pick(p, 'company_domain', 'domain', 'company_website', 'website')),
      city: text(pick(p, 'location', 'city', 'country')), email: workEmail(pick(p, 'email', 'work_email')),
      source_url: null };
    }).filter((p) => p.name);
    return store(env.DB, 'people', 'treg_people', q, people, charged);
  });
}

async function paidLock(db, key, run) {
  const until = new Date(Date.now() + 60_000).toISOString();
  const lock = await db.prepare(`INSERT INTO prospect_search_locks(search_key,locked_until) VALUES (?1,?2)
    ON CONFLICT(search_key) DO UPDATE SET locked_until=excluded.locked_until
    WHERE prospect_search_locks.locked_until<?3 RETURNING search_key`).bind(key, until, nowIso()).first();
  if (!lock) fail(409, 'This provider action is already running. Wait for its result before retrying.');
  try { return await run(); }
  finally { await db.prepare('DELETE FROM prospect_search_locks WHERE search_key=?1').bind(key).run(); }
}

export async function recentSearches(db) {
  const { results } = await db.prepare(`SELECT id,kind,source,query,results,observed_at,cost_micros FROM prospect_searches
    ORDER BY id DESC LIMIT 20`).all();
  return results.map((r) => ({ id: r.id, kind: r.kind, source: r.source, query: parseJson(r.query, {}),
    count: parseJson(r.results, []).length, observed_at: r.observed_at, cost_micros: r.cost_micros }));
}

export async function getSearch(db, id) {
  const row = await db.prepare('SELECT * FROM prospect_searches WHERE id=?1').bind(idOf(id)).first();
  if (!row) fail(404, 'Search not found');
  return { id: row.id, kind: row.kind, source: row.source, query: parseJson(row.query, {}),
    results: parseJson(row.results, []), observed_at: row.observed_at, cost_micros: row.cost_micros, cached: true };
}

async function evidence(db, kind, recordId, field, source, sourceUrl, at, status = 'observed', detail = '') {
  await db.prepare(`INSERT INTO prospect_evidence(kind,record_id,field,source,source_url,observed_at,status,detail)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
    ON CONFLICT(kind,record_id,field,source) DO UPDATE SET source_url=excluded.source_url,
    observed_at=excluded.observed_at,status=excluded.status,detail=excluded.detail`)
    .bind(kind, recordId, field, source, sourceUrl, at, status, detail).run();
}

export async function saveSearchResults(db, input) {
  const search = await db.prepare('SELECT * FROM prospect_searches WHERE id=?1').bind(idOf(input?.search_id)).first();
  if (!search) fail(404, 'Search not found');
  const results = parseJson(search.results, []), indices = input?.indices;
  const maximum = search.kind === 'people' ? 3 : 5;
  if (!Array.isArray(indices) || !indices.length || indices.length > maximum || !indices.every((n) => Number.isInteger(n) && n >= 0 && n < results.length))
    fail(400, `Save 1 to ${maximum} selected results at a time`);
  const output = { added: 0, existing: 0, records: [] };
  for (const index of [...new Set(indices)]) {
    const item = results[index];
    const previous = await db.prepare('SELECT record_id FROM prospect_search_saved WHERE search_id=?1 AND item_index=?2')
      .bind(search.id, index).first();
    if (previous) { output.existing++; output.records.push(previous.record_id); continue; }
    const kind = search.kind;
    let companyId = null;
    if (kind === 'people' && item.domain) {
      let company = await db.prepare('SELECT id FROM companies WHERE lower(domain)=?1 AND deleted_at IS NULL LIMIT 1').bind(item.domain).first();
      if (!company) company = await createRecord(db, 'companies', { name: item.company || item.domain, domain: item.domain });
      companyId = company.id;
      await evidence(db, 'companies', companyId, 'domain', search.source, item.source_url,
        search.observed_at, 'observed', 'Matched from a people search');
    }
    const sourceMatch = kind === 'companies' && item.source_url
      ? await db.prepare(`SELECT e.record_id AS id FROM prospect_evidence e JOIN companies c ON c.id=e.record_id
          WHERE e.kind='companies' AND e.field='name' AND e.source=?1 AND e.source_url=?2
          AND c.deleted_at IS NULL LIMIT 1`).bind(search.source, item.source_url).first() : null;
    const match = sourceMatch || (kind === 'companies' && item.domain
      ? await db.prepare('SELECT id FROM companies WHERE lower(domain)=?1 AND deleted_at IS NULL LIMIT 1').bind(item.domain).first()
      : kind === 'people' && item.email
        ? await db.prepare('SELECT id FROM people WHERE lower(email)=?1 AND deleted_at IS NULL LIMIT 1').bind(item.email).first()
        : kind === 'people' && companyId
          ? await db.prepare('SELECT id FROM people WHERE lower(name)=?1 AND company_id=?2 AND deleted_at IS NULL LIMIT 1')
            .bind(item.name.toLowerCase(), companyId).first()
        : null);
    const record = match || await createRecord(db, kind, kind === 'companies'
      ? { name: item.name, domain: item.domain, industry: item.industry, employees: item.employees,
        phone: item.phone, city: item.city }
      : { name: item.name, title: item.title, email: item.email || null, city: item.city,
        company_id: companyId, source: `Search: ${search.source}` });
    if (match) output.existing++; else output.added++;
    await db.prepare('INSERT INTO prospect_search_saved(search_id,item_index,kind,record_id) VALUES (?1,?2,?3,?4)')
      .bind(search.id, index, kind, record.id).run();
    for (const field of kind === 'companies' ? ['name', 'domain', 'industry', 'employees', 'phone', 'city'] : ['name', 'title', 'email', 'city']) {
      if (item[field]) await evidence(db, kind, record.id, field, search.source, item.source_url,
        search.observed_at, 'observed', `Value at observation: ${text(item[field], 500)}`);
    }
    output.records.push(record.id);
  }
  return output;
}

export async function enrichPerson(env, input, fetcher = globalThis.fetch.bind(globalThis)) {
  const id = idOf(input?.person_id), action = input?.action;
  const person = await env.DB.prepare(`SELECT p.id,p.name,p.email,c.domain FROM people p
    LEFT JOIN companies c ON c.id=p.company_id WHERE p.id=?1 AND p.deleted_at IS NULL`).bind(id).first();
  if (!person) fail(404, 'Person not found');
  if (action === 'email_find') {
    const companyDomain = domain(input?.domain || person.domain);
    if (!companyDomain) fail(400, 'Add the company domain before finding an email');
    const cap = capOf(input, 20_000);
    return paidLock(env.DB, `email_find:${id}`, async () => {
      const { output, charged } = await treg(env, 'treg.people.email.find', { full_name: person.name, domain: companyDomain }, cap, fetcher);
      const email = workEmail(output.email || output.work_email);
      if (!email) return { state: 'unknown_retry', charged_micros: charged };
      await updateRecord(env.DB, 'people', id, { email });
      await evidence(env.DB, 'people', id, 'email', 'treg.people.email.find', null, nowIso(), 'observed', 'Found, not verified');
      return { state: 'found_unverified', charged_micros: charged };
    });
  }
  if (action === 'email_verify') {
    if (!workEmail(person.email)) fail(400, 'Add a real work email before verification');
    const cap = capOf(input, 10_000);
    return paidLock(env.DB, `email_verify:${id}`, async () => {
      const { output, charged } = await treg(env, 'treg.people.email.verify', { email: person.email }, cap, fetcher);
      const verdict = text(output.status || output.result || output.verdict, 50).toLowerCase();
      const verified = ['valid', 'deliverable', 'ok', 'safe', 'verified'].includes(verdict);
      const state = !verdict ? 'unknown_retry' : verified ? 'verified' : 'unverified';
      await evidence(env.DB, 'people', id, 'email', 'treg.people.email.verify', null, nowIso(),
        verified ? 'verified' : 'unknown', verdict || 'No verdict, retry later');
      return { state, verdict: verdict || null, charged_micros: charged };
    });
  }
  fail(400, 'Choose email_find or email_verify');
}
