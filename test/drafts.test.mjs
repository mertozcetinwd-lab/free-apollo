import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client } from './helpers.mjs';

test('first message uses only a cited company observation and never sends', async () => {
  const env = fakeEnv(), api = await client(env);
  const company = (await api.post('/api/companies', { name: 'Sample Workshop', industry: 'plumbing' })).body;
  const person = (await api.post('/api/people', { name: 'Sample Contact', title: 'Owner', company_id: company.id })).body;
  const missing = await api.post('/api/prospect/draft', { company_id: company.id, person_id: person.id,
    offer: 'a missed-call AI voice agent' });
  assert.match(missing.body.body, /{{source-backed observation about the company}}/);
  assert.equal(missing.body.source, null);
  assert.equal(missing.body.sending_enabled, false);
  await env.DB.prepare(`INSERT INTO prospect_evidence(kind,record_id,field,source,source_url,observed_at,status,detail)
    VALUES ('companies',?1,'industry','Public map','https://example.com/source','2026-09-30T00:00:00.000Z','observed','Value at observation: plumbing')`)
    .bind(company.id).run();
  const sourced = await api.post('/api/prospect/draft', { company_id: company.id, person_id: person.id,
    offer: 'a missed-call AI voice agent' });
  assert.match(sourced.body.body, /listed under plumbing/);
  assert.equal(sourced.body.source.url, 'https://example.com/source');
  assert.equal(sourced.body.review_required, true);
  await api.patch(`/api/companies/${company.id}`, { industry: 'electrical' });
  const changed = await api.post('/api/prospect/draft', { company_id: company.id, person_id: person.id,
    offer: 'a missed-call AI voice agent' });
  assert.match(changed.body.body, /{{source-backed observation about the company}}/);
  assert.equal(changed.body.source, null);
});

test('first message rejects an unrelated person and empty offer', async () => {
  const env = fakeEnv(), api = await client(env);
  const company = (await api.post('/api/companies', { name: 'Sample Workshop' })).body;
  const other = (await api.post('/api/people', { name: 'Sample Contact' })).body;
  assert.equal((await api.post('/api/prospect/draft', { company_id: company.id, person_id: other.id,
    offer: 'an assistant' })).status, 400);
  assert.equal((await api.post('/api/prospect/draft', { company_id: company.id, offer: '' })).status, 400);
});
