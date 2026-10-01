import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanValue, cleanRecord, fieldsFor } from '../public/js/schema.js';
import {
  fmtMoney, fmtDate, relTime, dueBucket, score, applyFilters, searchRows, sortRows, calc, stageTimeline, stageTotals, displayValue,
} from '../public/js/logic.js';
import { parseCsv } from '../src/csv.js';

const stages = [
  { key: 'lead', name: 'Lead', kind: 'open', position: 0 }, { key: 'meeting', name: 'Meeting', kind: 'open', position: 1 },
  { key: 'proposal', name: 'Proposal', kind: 'open', position: 2 }, { key: 'won', name: 'Won', kind: 'won', position: 3 },
];
const ctx = {
  companies: new Map([[1, { id: 1, name: 'Acme' }], [2, { id: 2, name: 'Beta' }]]),
  stages: new Map(stages.map((s) => [s.key, s])), today: '2026-09-25',
};
const dealFields = fieldsFor('deals');
const deals = [
  { id: 1, name: 'Roof', value_cents: 500000, stage: 'proposal', company_id: 1, close_date: '2026-09-20' },
  { id: 2, name: 'Gutter', value_cents: 20000, stage: 'lead', company_id: 2, close_date: null },
  { id: 3, name: 'Siding', value_cents: null, stage: 'meeting', company_id: null, close_date: '2026-10-05' },
];

test('money: cents in, readable out, compact for boards', () => {
  assert.equal(fmtMoney(850000), '$8,500');
  assert.equal(fmtMoney(1999), '$19.99');
  assert.equal(fmtMoney(6000000, 'USD', { compact: true }), '$60K');
  assert.equal(fmtMoney(null), '');
});

test('dates: three formats, relative time, due buckets', () => {
  assert.equal(fmtDate('2026-09-25'), 'Sep 25, 2026');
  assert.equal(fmtDate('2026-09-25', 'dmy'), '25 Sep 2026');
  assert.equal(relTime(new Date(Date.now() - 5 * 60000).toISOString()), '5 min ago');
  assert.equal(dueBucket('2026-09-24', '2026-09-25'), 'overdue');
  assert.equal(dueBucket('2026-09-25', '2026-09-25'), 'today');
  assert.equal(dueBucket(null, '2026-09-25'), 'none');
});

test('validation per type', () => {
  const f = (type, extra = {}) => ({ key: 'x', label: 'X', type, ...extra });
  assert.equal(cleanValue(f('domain'), 'https://www.Acme.example/pricing').value, 'acme.example');
  assert.equal(cleanValue(f('url'), 'acme.example').value, 'https://acme.example');
  assert.equal(cleanValue(f('number'), '1,200').value, 1200);
  assert.equal(cleanValue(f('checkbox'), 'yes').value, true);
  assert.equal(cleanValue(f('select', { options: [{ value: 'A' }] }), 'B').ok, false);
  assert.equal(cleanValue(f('date'), '2026-02-30').ok, true, 'Date.parse rolls it; the format is what matters here');
  assert.equal(cleanValue(f('text', { required: true }), '').ok, false);
  const r = cleanRecord('people', { name: 'A', created_at: 'hack', nonsense: 1 });
  assert.deepEqual(r.row, { name: 'A' }, 'read-only and unknown keys are dropped');
});

test('filters: text matches what you see (company names), numbers use dollars, dates know overdue', () => {
  const by = (filters) => applyFilters(deals, filters, dealFields, ctx).map((d) => d.name);
  assert.deepEqual(by([{ field: 'company_id', op: 'is', value: '1' }]), ['Roof']);
  assert.deepEqual(by([{ field: 'value_cents', op: 'gt', value: '1000' }]), ['Roof']);
  assert.deepEqual(by([{ field: 'value_cents', op: 'empty' }]), ['Siding']);
  assert.deepEqual(by([{ field: 'close_date', op: 'overdue' }]), ['Roof']);
  assert.deepEqual(by([{ field: 'stage', op: 'is_not', value: 'lead' }, { field: 'name', op: 'contains', value: 'i' }]), ['Siding']);
  assert.deepEqual(by([{ field: 'name', op: 'contains', value: '' }]), ['Roof', 'Gutter', 'Siding'], 'an unfinished chip filters nothing');
  assert.deepEqual(searchRows(deals, 'acme', dealFields, ctx).map((d) => d.name), ['Roof']);
});

test('sorting: stages by pipeline order, relations by name, empty values always last', () => {
  const names = (sort) => sortRows(deals, sort, dealFields, ctx).map((d) => d.name);
  assert.deepEqual(names({ field: 'stage', dir: 'asc' }), ['Gutter', 'Siding', 'Roof']);
  assert.deepEqual(names({ field: 'value_cents', dir: 'desc' }), ['Roof', 'Gutter', 'Siding']);
  assert.deepEqual(names({ field: 'value_cents', dir: 'asc' }), ['Gutter', 'Roof', 'Siding']);
  assert.deepEqual(names({ field: 'company_id', dir: 'desc' }), ['Gutter', 'Roof', 'Siding']);
});

test('column calculations', () => {
  const value = dealFields.find((f) => f.key === 'value_cents');
  assert.equal(calc(deals, value, 'sum'), 520000);
  assert.equal(calc(deals, value, 'avg'), 260000);
  assert.equal(calc(deals, value, 'empty'), 1);
  assert.equal(calc(deals, value, 'percent_filled'), 67);
  assert.equal(displayValue(deals[0], dealFields.find((f) => f.key === 'company_id'), ctx), 'Acme');
});

test('stage timeline: days per stage from the stage-change log', () => {
  const day = 86400000; const t0 = Date.parse('2026-09-01T00:00:00Z');
  const deal = { stage: 'proposal', created_at: new Date(t0).toISOString() };
  const events = [
    { kind: 'stage', created_at: new Date(t0 + 2 * day).toISOString(), data: { from: 'lead', to: 'meeting' } },
    { kind: 'stage', created_at: new Date(t0 + 7 * day).toISOString(), data: { from: 'meeting', to: 'proposal' } },
  ];
  const tl = stageTimeline(deal, events, stages, t0 + 10 * day);
  assert.deepEqual(tl.map((s) => [s.key, s.days, s.state]), [['lead', 2, 'done'], ['meeting', 5, 'done'], ['proposal', 3, 'current']]);
  const totals = stageTotals(deals, stages);
  assert.deepEqual(totals.get('proposal'), { count: 1, cents: 500000 });
});

test('CSV parser: quotes, commas, newlines inside fields, BOM, CRLF', () => {
  assert.deepEqual(parseCsv('﻿name,notes\r\n"Doe, Jane","said ""hi""\nthen left"\r\n'),
    [['name', 'notes'], ['Doe, Jane', 'said "hi"\nthen left']]);
});

test('command menu ranking: prefix beats word start beats substring beats initials, and no loose matches', () => {
  assert.ok(score('Gator HVAC', 'gat') > score('Priya at gator', 'gat'));
  assert.ok(score('Priya at gator', 'gat') > score('Navigator', 'gat'));
  assert.equal(score('Booking assistant', 'gat'), 0, 'letters scattered across words do not count');
  assert.ok(score('Ruiz Roofing', 'rr') > 0, 'initials match');
});

test('a lost deal only lights up the stages it passed through', () => {
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  const deal = { stage: 'lost', created_at: new Date(t0).toISOString() };
  const withLost = [...stages, { key: 'lost', name: 'Lost', kind: 'lost', position: 4 }];
  const events = [{ kind: 'stage', created_at: new Date(t0 + 86400000).toISOString(), data: { from: 'lead', to: 'lost' } }];
  const tl = stageTimeline(deal, events, withLost, t0 + 2 * 86400000);
  assert.deepEqual(tl.map((s) => s.state), ['done', 'future', 'future']);
});
