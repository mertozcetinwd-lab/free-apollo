import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client } from './helpers.mjs';
import { parseWikidata, searchCompanies, geocodePlace, searchLocalCompanies, searchPeople, enrichPerson } from '../src/discovery.js';

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
