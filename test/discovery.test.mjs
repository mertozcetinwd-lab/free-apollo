import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client } from './helpers.mjs';
import { parseWikidata, searchCompanies, geocodePlace, searchLocalCompanies, searchCompanySitePeople,
  searchPeople, enrichPerson } from '../src/discovery.js';

const wikidata = { results: { bindings: [{ c: { value: 'http://www.wikidata.org/entity/Q123' },
  cLabel: { value: 'Sample Workshop' }, site: { value: 'https://sample.example/' },
  indLabel: { value: 'Software' }, emp: { value: '24' } }] } };

test('public company search saves source-backed records and repeats from cache', async () => {
  const env = fakeEnv(), api = await client(env);
  let calls = 0;
  const fetcher = async () => { calls++; return new Response(JSON.stringify(wikidata)); };
  const first = await searchCompanies(env.DB, { industry: 'software' }, fetcher);
  assert.equal(first.results[0].domain, 'sample.example');
  assert.equal(first.cost_micros, 0);
  const again = await searchCompanies(env.DB, { industry: 'software' }, fetcher);
  assert.equal(again.cached, true);
  assert.equal(calls, 1);
  const saved = await api.post('/api/prospect/search/save', { search_id: first.id, indices: [0] });
  assert.equal(saved.body.added, 1);
  assert.equal((await api.post('/api/prospect/search/save', { search_id: first.id, indices: [0] })).body.existing, 1);
  const evidence = (await api.get(`/api/prospect/evidence/companies/${saved.body.records[0]}`)).body;
  assert.ok(evidence.some((row) => row.field === 'domain' && row.source_url.endsWith('/Q123')));
});

test('company search failures are retryable, not an empty success', async () => {
  const env = fakeEnv(), api = await client(env);
  assert.equal((await api.post('/api/prospect/search/companies', { industry: '' })).status, 400);
  await assert.rejects(searchCompanies(env.DB, { industry: 'software' }, async () => new Response('', { status: 503 })),
    /Wikidata returned 503/);
  assert.deepEqual(parseWikidata({ results: { bindings: [{ c: { value: 'bad' } }] } }), []);
});

test('official page search keeps named leaders as source-backed candidates without inventing email verification', async () => {
  const env = fakeEnv(), api = await client(env);
  const company = (await api.post('/api/companies', { name: 'Sample Workshop', domain: 'sample.example' })).body;
  const html = `<html><script type="application/ld+json">{"@graph":[
    {"@type":"Person","name":"Alex Sample","jobTitle":"Founder"},
    {"@type":"Person","name":"Sam Example","jobTitle":"Engineer"}]}</script></html>`;
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.equal(url, 'https://sample.example/about/');
    assert.equal(options.redirect, 'manual');
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  };
  const first = await searchCompanySitePeople(env.DB, { company_id: company.id, url: 'https://sample.example/about/' }, fetcher);
  assert.equal(first.results.length, 1);
  assert.equal(first.results[0].name, 'Alex Sample');
  assert.equal(first.results[0].email, undefined);
  assert.equal(first.cost_micros, 0);
  assert.equal((await searchCompanySitePeople(env.DB, { company_id: company.id, url: 'https://sample.example/about/' }, fetcher)).cached, true);
  assert.equal(calls, 1);
  const saved = await api.post('/api/prospect/search/save', { search_id: first.id, indices: [0] });
  assert.equal(saved.body.added, 1);
  const record = (await api.get(`/api/people/${saved.body.records[0]}`)).body;
  assert.equal(record.email, null);
  const evidence = (await api.get(`/api/prospect/evidence/people/${record.id}`)).body;
  assert.ok(evidence.some((e) => e.field === 'title' && e.status === 'observed' && e.source_url === 'https://sample.example/about/'));
});

test('company page fetch stays on the saved HTTPS domain and fails loudly on redirects and bad content', async () => {
  const env = fakeEnv(), api = await client(env);
  const company = (await api.post('/api/companies', { name: 'Sample Workshop', domain: 'sample.example' })).body;
  const input = { company_id: company.id, url: 'https://sample.example/about/' };
  const never = async () => { throw new Error('Network must not run'); };
  await assert.rejects(searchCompanySitePeople(env.DB, { ...input, url: 'https://sample.example.evil.com/about' }, never), /saved company domain/);
  await assert.rejects(searchCompanySitePeople(env.DB, { ...input, url: 'http://sample.example/about' }, never), /HTTPS/);
  await assert.rejects(searchCompanySitePeople(env.DB, input, async () => new Response('', { status: 302, headers: { location: 'https://evil.com/' } })), /redirected/);
  await assert.rejects(searchCompanySitePeople(env.DB, input, async () => new Response('{}', { headers: { 'content-type': 'application/json' } })), /did not return HTML/);
  await assert.rejects(searchCompanySitePeople(env.DB, input, async () => { throw new Error('offline'); }), /could not be reached/);
  await assert.rejects(searchCompanySitePeople(env.DB, input, async () => new Response('x'.repeat(500_001),
    { headers: { 'content-type': 'text/html' } })), /500 KB reading limit/);
});

test('user-guided website leader must appear with the role nearby in page copy', async () => {
  const env = fakeEnv(), api = await client(env);
  const company = (await api.post('/api/companies', { name: 'Sample Workshop', domain: 'sample.example' })).body;
  const fetcher = async () => new Response('<html><h2>Meet the Owner</h2><p>Alex Sample founded the shop in 2010.</p></html>',
    { headers: { 'content-type': 'text/html' } });
  const query = { company_id: company.id, url: 'https://sample.example/team', name: 'Alex Sample', title: 'Owner' };
  const found = await searchCompanySitePeople(env.DB, query, fetcher);
  assert.deepEqual(found.results.map((r) => r.name), ['Alex Sample']);
  await assert.rejects(searchCompanySitePeople(env.DB, { ...query, name: 'Another Person' }, fetcher), /not found together/);
  await assert.rejects(searchCompanySitePeople(env.DB, { ...query, title: 'Engineer' }, fetcher), /owner or founder role/);
  await assert.rejects(searchCompanySitePeople(env.DB, { ...query, name: 'Alex Sample', url: 'https://sample.example/empty' },
    async () => new Response('<html><p>Alex Sample</p><p>'.concat('Other information '.repeat(100), 'Owner</p></html>'),
      { headers: { 'content-type': 'text/html' } })), /not found together/);
});

test('local business search geocodes once, checks map results and saves source evidence', async () => {
  const env = fakeEnv(), api = await client(env);
  env.NOMINATIM_CONTACT_EMAIL = 'maintainer@example.com';
  let calls = 0;
  const fetcher = async (_url, options) => {
    calls++;
    assert.match(options.headers['user-agent'], /maintainer@example.com/);
    return new Response(JSON.stringify([{ lat: '29.65', lon: '-82.32', display_name: 'Gainesville, Florida' }]));
  };
  const place = await geocodePlace(env.DB, env, { place: 'Gainesville, FL' }, fetcher);
  assert.equal(place.lat, 29.65);
  assert.equal((await geocodePlace(env.DB, env, { place: 'gainesville, fl' }, fetcher)).cached, true);
  assert.equal(calls, 1);
  await assert.rejects(geocodePlace(env.DB, env, { place: 'Ocala, FL' }, fetcher), /cooling down/);
  const search = await searchLocalCompanies(env.DB, { lat: place.lat, lon: place.lon, radius_m: 10000,
    category: 'plumber', elements: [
      { type: 'node', id: 123, lat: 29.65, lon: -82.32,
        tags: { name: 'Sample Plumbing', craft: 'plumber', website: 'https://sample.example', 'addr:city': 'Gainesville' } },
      { type: 'node', id: 124, lat: 40, lon: -74, tags: { name: 'Far Away', craft: 'plumber' } },
      { type: 'node', id: 125, lat: 29.65, lon: -82.32, tags: { name: 'Wrong Trade', craft: 'roofer' } },
    ] });
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].domain, 'sample.example');
  const save = await api.post('/api/prospect/search/save', { search_id: search.id, indices: [0] });
  assert.equal(save.body.added, 1);
  const evidence = (await api.get(`/api/prospect/evidence/companies/${save.body.records[0]}`)).body;
  assert.ok(evidence.some((row) => row.source_url === 'https://www.openstreetmap.org/node/123'));
});

test('paid people search enforces cap, logs actual charge and caches the result', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'test-only-token';
  const api = await client(env);
  assert.equal((await api.post('/api/prospect/search/people', { title: 'Owner' })).status, 400);
  assert.equal((await api.post('/api/prospect/search/people', { title: 'Owner', approved: true, max_micros: 100001 })).status, 400);
  let calls = 0, header;
  const fetcher = async (_url, options) => {
    calls++; header = options.headers['x-treg-route-max-cost'];
    return new Response(JSON.stringify({ output: { people: [{ first_name: 'Sample', last_name: 'Contact', job_title: 'Owner',
      organization_name: 'Sample Workshop', company_website: 'https://sample.example',
      work_email: 'you@example.com', linkedin_url: 'https://invalid.example/profile' }] } }),
      { headers: { 'x-treg-cost-micro': '4500' } });
  };
  await assert.rejects(searchPeople(env, { title: 'Owner', max_micros: 100001, approved: true }, fetcher), /maximum cost/);
  await assert.rejects(searchPeople(env, { title: 'Owner', max_micros: 10000 }, fetcher), /Confirm/);
  const first = await searchPeople(env, { title: 'Owner', max_micros: 10000, approved: true }, fetcher);
  assert.equal(header, '0.010000');
  assert.equal(first.cost_micros, 4500);
  assert.equal(first.results[0].name, 'Sample Contact');
  assert.equal(first.results[0].domain, 'sample.example');
  assert.equal(first.results[0].email, '');
  assert.equal(first.results[0].source_url, null);
  const second = await searchPeople(env, { title: 'Owner' }, fetcher);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  assert.equal((await api.get('/api/prospect/costs')).body[0].charged_micros, 4500);
});

test('duplicate people requests cannot make two provider calls', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'test-only-token';
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const fetcher = async () => {
    calls++;
    await waiting;
    return new Response(JSON.stringify({ output: { people: [{ full_name: 'Sample Contact' }] } }),
      { headers: { 'x-treg-cost-micro': '1000' } });
  };
  const input = { title: 'Owner', max_micros: 10000, approved: true };
  const first = searchPeople(env, input, fetcher);
  await assert.rejects(searchPeople(env, input, fetcher), /already running/);
  release();
  await first;
  assert.equal(calls, 1);
  assert.equal((await searchPeople(env, input, fetcher)).cached, true);
});

test('missing charge header is reported as unknown, not free', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'test-only-token';
  await assert.rejects(searchPeople(env, { title: 'Owner', max_micros: 10000, approved: true },
    async () => new Response(JSON.stringify({ output: { people: [] } }))), /did not report a usable charge/);
  const api = await client(env);
  assert.equal((await api.get('/api/prospect/costs')).body[0].outcome, 'charge_unknown');
});

test('duplicate email finding cannot spend twice for one person', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'test-only-token';
  const api = await client(env);
  const person = (await api.post('/api/people', { name: 'Sample Contact' })).body;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const fetcher = async () => {
    calls++;
    await waiting;
    return new Response(JSON.stringify({ output: { email: 'contact@sample.example' } }),
      { headers: { 'x-treg-cost-micro': '1000' } });
  };
  const input = { person_id: person.id, action: 'email_find', domain: 'sample.example',
    max_micros: 5000, approved: true };
  const first = enrichPerson(env, input, fetcher);
  await assert.rejects(enrichPerson(env, input, fetcher), /already running/);
  release();
  assert.equal((await first).state, 'found_unverified');
  assert.equal(calls, 1);
});

test('finding an email does not verify it; a catch-all verdict stays unverified', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'test-only-token';
  const api = await client(env);
  const p = (await api.post('/api/people', { name: 'Sample Contact' })).body;
  const finder = async () => new Response(JSON.stringify({ output: { email: 'contact@sample.example' } }),
    { headers: { 'x-treg-cost-micro': '3000' } });
  const found = await enrichPerson(env, { person_id: p.id, action: 'email_find', domain: 'sample.example',
    approved: true, max_micros: 5000 }, finder);
  assert.equal(found.state, 'found_unverified');
  const before = (await api.get(`/api/prospect/evidence/people/${p.id}`)).body;
  assert.equal(before[0].status, 'observed');
  const verifier = async () => new Response(JSON.stringify({ output: { status: 'valid-risky' } }),
    { headers: { 'x-treg-cost-micro': '1000' } });
  const result = await enrichPerson(env, { person_id: p.id, action: 'email_verify', approved: true,
    max_micros: 2000 }, verifier);
  assert.equal(result.state, 'unverified');
  const after = (await api.get(`/api/prospect/evidence/people/${p.id}`)).body;
  assert.equal(after.find((row) => row.source === 'treg.people.email.verify').status, 'unknown');
});
