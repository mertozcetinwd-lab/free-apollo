import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client } from './helpers.mjs';

const company = { data: { name: 'Sample Workshop', domain: 'sample.example', industry: 'Services' }, source: 'Free Clay sample', observed_at: '2026-09-30T10:00:00.000Z' };
const person = { data: { full_name: 'Sample Contact', email: 'contact@sample.example', title: 'Owner' }, source: 'Free Clay sample', observed_at: '2026-09-30T10:00:00.000Z' };

test('transfer deduplicates known records and records evidence without inventing verification', async () => {
  const env = fakeEnv(), api = await client(env);
  const first = await api.post('/api/prospect/transfer', { kind: 'companies', records: [company] });
  assert.deepEqual({ added: first.body.added, existing: first.body.existing }, { added: 1, existing: 0 });
  const second = await api.post('/api/prospect/transfer', { kind: 'companies', records: [company] });
  assert.equal(second.body.existing, 1);
  const people = await api.post('/api/prospect/transfer', { kind: 'people', records: [person, { data: { full_name: 'Unknown Contact' } }] });
  assert.equal(people.body.added, 1);
  assert.equal(people.body.skipped, 1);
  const again = await api.post('/api/prospect/transfer', { kind: 'people', records: [person] });
  assert.equal(again.body.existing, 1);
  const saved = (await api.get('/api/people')).body;
  assert.equal(saved.length, 1);
  const proof = (await api.get(`/api/prospect/evidence/people/${saved[0].id}`)).body;
  assert.equal(proof[0].status, 'observed');
  assert.equal(proof[0].source, 'Free Clay sample');
  assert.equal((await api.get('/api/prospect/overview')).body.charged_micros, 0);
});

test('transfer keeps field sources and treats a missing observation date as unknown', async () => {
  const api = await client(fakeEnv());
  const item = { data: { name: 'Sample Workshop', domain: 'sample.example', industry: 'Services' },
    sources: { name: { source: 'Public registry', at: '2026-09-29T10:00:00.000Z', url: 'https://example.com/source' },
      industry: { source: 'Company website' } } };
  assert.equal((await api.post('/api/prospect/transfer', { kind: 'companies', records: [item] })).status, 200);
  const id = (await api.get('/api/companies')).body[0].id;
  const proof = (await api.get(`/api/prospect/evidence/companies/${id}`)).body;
  assert.deepEqual(proof.map((x) => [x.field, x.source, x.status]).sort(),
    [['industry', 'Company website', 'unknown'], ['name', 'Public registry', 'observed']]);
  assert.equal(proof.find((x) => x.field === 'name').source_url, 'https://example.com/source');
  await api.post('/api/prospect/transfer', { kind: 'companies', records: [{ ...item,
    sources: { name: { source: 'Public registry' } } }] });
  const again = (await api.get(`/api/prospect/evidence/companies/${id}`)).body;
  assert.equal(again.find((x) => x.field === 'name').status, 'observed');
  assert.equal(again.find((x) => x.field === 'name').source_url, 'https://example.com/source');
});

test('lists contain only existing records and sequence enrollment is a plan, never a send', async () => {
  const api = await client(fakeEnv());
  const p = (await api.post('/api/people', { name: 'Sample Contact', email: 'contact@sample.example' })).body;
  const list = (await api.post('/api/prospect/lists', { name: 'Review', kind: 'people' })).body;
  const bad = await api.post(`/api/prospect/lists/${list.id}/members`, { ids: [999] });
  assert.equal(bad.status, 400);
  const added = await api.post(`/api/prospect/lists/${list.id}/members`, { ids: [p.id] });
  assert.equal(added.body.records.length, 1);
  const seq = (await api.post('/api/prospect/sequences', { name: 'Draft review', steps: [
    { type: 'email_draft', delay_days: 0, subject: 'Hello', body: 'Review before use', variant: 'A' },
    { type: 'manual_task', delay_days: 3, body: 'Check response', variant: 'A' },
  ] })).body;
  assert.equal(seq.status, 'draft');
  const planned = await api.post(`/api/prospect/sequences/${seq.id}/plan`, { person_ids: [p.id] });
  assert.deepEqual(planned.body, { planned: 1, sending_enabled: false });
  const people = (await api.get(`/api/prospect/sequences/${seq.id}/plan`)).body;
  assert.deepEqual(people.map((x) => x.state), ['planned']);
  const paused = await api.patch(`/api/prospect/sequences/${seq.id}/plan/${p.id}`, { state: 'paused' });
  assert.equal(paused.body.state, 'paused');
  assert.equal(paused.body.sending_enabled, false);
  assert.equal((await api.get('/api/prospect/sequences')).body[0].planned, 1);
  assert.equal((await api.get('/api/prospect/costs')).body.length, 0);
});

test('transfer refuses oversized batches and sequence steps with invalid timing', async () => {
  const api = await client(fakeEnv());
  assert.equal((await api.post('/api/prospect/transfer', { kind: 'people', records: Array(6).fill(person) })).status, 400);
  assert.equal((await api.post('/api/prospect/sequences', { name: 'Bad', steps: [{ type: 'email_draft', delay_days: -1, subject: 'Hi', body: 'Text' }] })).status, 400);
});

test('sequence editor stores Apollo-style step types, timing, schedule and safety rules as drafts', async () => {
  const api = await client(fakeEnv());
  const payload = { name: 'Sample outreach plan', steps: [
    { type: 'manual_email', delay_value: 30, delay_unit: 'minutes', subject: 'Sample', body: 'Review manually', variant: 'A' },
    { type: 'phone_call', delay_value: 2, delay_unit: 'days', body: 'Call after review', variant: 'A' },
    { type: 'linkedin_connection', delay_value: 3, delay_unit: 'hours', body: 'Manual reminder only', variant: 'B' },
  ], schedule: { days: [1, 3, 5], start: '09:00', end: '16:00', timezone: 'America/New_York' },
    rules: { stop_on_reply: true, stop_on_meeting: true, pause_on_ooo: true, bounce_guard: true, daily_cap: 20 } };
  const created = await api.post('/api/prospect/sequences', payload);
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'draft');
  assert.equal(created.body.steps[0].delay_unit, 'minutes');
  assert.equal(created.body.steps[2].type, 'linkedin_connection');
  assert.equal(created.body.schedule.start, '09:00');
  assert.equal(created.body.rules.daily_cap, 20);
  assert.equal((await api.post('/api/prospect/sequences', { ...payload,
    schedule: { ...payload.schedule, start: '17:00' } })).status, 400);
  assert.equal((await api.post('/api/prospect/sequences', { ...payload,
    rules: { ...payload.rules, daily_cap: -1 } })).status, 400);
  assert.equal((await api.post('/api/prospect/sequences', { ...payload,
    steps: [{ ...payload.steps[0], delay_value: -1 }] })).status, 400);
});
