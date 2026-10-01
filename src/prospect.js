import { fail, nowIso, parseJson } from './util.js';
import { createRecord } from './records.js';

const kindOf = (v) => ['people', 'companies'].includes(v) ? v : fail(400, 'Choose people or companies');
const positiveId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : fail(400, 'Bad id'); };
const trim = (v, max) => String(v ?? '').trim().slice(0, max);
const domain = (v) => trim(v, 500).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
const observedAt = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(v) && !Number.isNaN(Date.parse(v))
  ? new Date(v).toISOString() : null;
const sourceUrl = (v) => { const value = trim(v, 500); return /^https:\/\/[^\s/]+(?:\/[^\s]*)?$/i.test(value) ? value : null; };

export async function overview(db) {
  const [people, companies, lists, sequences, tasks, costs] = await Promise.all([
    db.prepare('SELECT count(*) AS n FROM people WHERE deleted_at IS NULL').first(),
    db.prepare('SELECT count(*) AS n FROM companies WHERE deleted_at IS NULL').first(),
    db.prepare('SELECT count(*) AS n FROM prospect_lists').first(),
    db.prepare('SELECT count(*) AS n FROM prospect_sequences').first(),
    db.prepare('SELECT count(*) AS n FROM tasks WHERE done_at IS NULL AND deleted_at IS NULL').first(),
    db.prepare(`SELECT coalesce(sum(charged_micros),0) AS n,
      coalesce(sum(CASE WHEN outcome IN ('charge_unknown','unknown_retry') THEN 1 ELSE 0 END),0) AS uncertain
      FROM prospect_costs`).first(),
  ]);
  return { people: people.n, companies: companies.n, lists: lists.n, sequences: sequences.n,
    open_tasks: tasks.n, charged_micros: costs.n, uncertain_costs: costs.uncertain };
}

export async function lists(db, kind) {
  const k = kind ? kindOf(kind) : null;
  const { results } = await db.prepare(`SELECT l.*, count(m.record_id) AS members FROM prospect_lists l
    LEFT JOIN prospect_list_members m ON m.list_id=l.id WHERE (?1 IS NULL OR l.kind=?1)
    GROUP BY l.id ORDER BY l.updated_at DESC`).bind(k).all();
  return results;
}

export async function createList(db, input) {
  const kind = kindOf(input?.kind), name = trim(input?.name, 80);
  if (!name) fail(400, 'Name the list');
  const at = nowIso();
  return db.prepare('INSERT INTO prospect_lists(name,kind,created_at,updated_at) VALUES (?1,?2,?3,?3) RETURNING *')
    .bind(name, kind, at).first();
}

export async function listMembers(db, id) {
  const list = await db.prepare('SELECT * FROM prospect_lists WHERE id=?1').bind(positiveId(id)).first();
  if (!list) fail(404, 'List not found');
  const { results } = await db.prepare(`SELECT r.* FROM prospect_list_members m JOIN ${list.kind} r ON r.id=m.record_id
    WHERE m.list_id=?1 AND r.deleted_at IS NULL ORDER BY r.name COLLATE NOCASE LIMIT 500`).bind(list.id).all();
  return { list, records: results };
}

export async function changeMembers(db, id, input, remove = false) {
  const list = await db.prepare('SELECT * FROM prospect_lists WHERE id=?1').bind(positiveId(id)).first();
  if (!list) fail(404, 'List not found');
  const ids = input?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 20 || !ids.every((x) => Number.isInteger(x) && x > 0)) fail(400, 'Choose 1 to 20 record ids');
  const { results } = await db.prepare(`SELECT id FROM ${list.kind} WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids)).all();
  if (results.length !== new Set(ids).size) fail(400, 'A selected record was not found');
  const statements = ids.map((recordId) => remove
    ? db.prepare('DELETE FROM prospect_list_members WHERE list_id=?1 AND record_id=?2').bind(list.id, recordId)
    : db.prepare('INSERT OR IGNORE INTO prospect_list_members(list_id,record_id) VALUES (?1,?2)').bind(list.id, recordId));
  statements.push(db.prepare('UPDATE prospect_lists SET updated_at=?2 WHERE id=?1').bind(list.id, nowIso()));
  await db.batch(statements);
  return listMembers(db, list.id);
}

function stepsOf(input) {
  if (!Array.isArray(input) || input.length > 20) fail(400, 'A sequence has up to 20 steps');
  return input.map((x, i) => {
    const type = x?.type;
    if (!['email_draft', 'automatic_email_draft', 'manual_email', 'manual_task', 'phone_call', 'action_item',
      'linkedin_connection', 'linkedin_message', 'linkedin_view', 'linkedin_post'].includes(type)) fail(400, `Step ${i + 1} has an unknown type`);
    const delay_unit = x.delay_unit || 'days';
    if (!['minutes', 'hours', 'days'].includes(delay_unit)) fail(400, `Step ${i + 1} has a bad delay unit`);
    const delay_value = Number(x.delay_value ?? x.delay_days ?? 0);
    if (!Number.isInteger(delay_value) || delay_value < 0 || delay_value > 365) fail(400, `Step ${i + 1} has a bad delay`);
    const delay_days = delay_unit === 'days' ? delay_value : 0;
    if (!Number.isInteger(delay_days) || delay_days < 0 || delay_days > 365) fail(400, `Step ${i + 1} has a bad delay`);
    const subject = trim(x.subject, 180), body = trim(x.body, 10000);
    if (!body) fail(400, `Step ${i + 1} needs text`);
    if (['email_draft', 'automatic_email_draft', 'manual_email'].includes(type) && !subject) fail(400, `Step ${i + 1} needs a subject`);
    return { type, delay_days, delay_value, delay_unit, subject, body, variant: trim(x.variant, 30) || 'A' };
  });
}

const defaultSchedule = { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', timezone: 'local' };
const defaultRules = { stop_on_reply: true, stop_on_meeting: true, pause_on_ooo: true, bounce_guard: true, daily_cap: 50 };
function scheduleOf(raw) {
  if (!raw) return defaultSchedule;
  const days = raw.days;
  if (!Array.isArray(days) || !days.length || days.length > 7 || !days.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)) fail(400, 'Choose schedule days');
  const start = trim(raw.start, 5), end = trim(raw.end, 5), timezone = trim(raw.timezone, 80) || 'local';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || start >= end) fail(400, 'Choose valid start and end times');
  return { days: [...new Set(days)].sort(), start, end, timezone };
}
function rulesOf(raw) {
  if (!raw) return defaultRules;
  const cap = Number(raw.daily_cap);
  if (!Number.isInteger(cap) || cap < 0 || cap > 1000) fail(400, 'Daily cap must be 0 to 1000');
  return Object.fromEntries(Object.keys(defaultRules).map((key) => [key, key === 'daily_cap' ? cap : raw[key] === true]));
}
const sequenceOut = (x) => x && { ...x, steps: parseJson(x.steps, []),
  schedule: parseJson(x.schedule, defaultSchedule), rules: parseJson(x.rules, defaultRules) };
export async function sequences(db) {
  const { results } = await db.prepare(`SELECT s.*, (SELECT count(*) FROM prospect_enrollments e WHERE e.sequence_id=s.id) AS planned
    FROM prospect_sequences s ORDER BY s.updated_at DESC`).all();
  return results.map(sequenceOut);
}
export async function saveSequence(db, input, id) {
  const name = trim(input?.name, 100), description = trim(input?.description, 500), steps = stepsOf(input?.steps);
  const schedule = scheduleOf(input?.schedule), rules = rulesOf(input?.rules);
  if (!name) fail(400, 'Name the sequence');
  const at = nowIso();
  if (id) {
    const result = await db.prepare(`UPDATE prospect_sequences SET name=?2, description=?3, steps=?4, updated_at=?5,
      schedule=?6,rules=?7 WHERE id=?1 RETURNING *`).bind(positiveId(id), name, description, JSON.stringify(steps), at,
      JSON.stringify(schedule), JSON.stringify(rules)).first();
    if (!result) fail(404, 'Sequence not found');
    return sequenceOut(result);
  }
  return sequenceOut(await db.prepare(`INSERT INTO prospect_sequences(name,description,steps,created_at,updated_at,schedule,rules)
    VALUES (?1,?2,?3,?4,?4,?5,?6) RETURNING *`).bind(name, description, JSON.stringify(steps), at,
    JSON.stringify(schedule), JSON.stringify(rules)).first());
}
export async function planSequence(db, id, input) {
  const sid = positiveId(id);
  if (!(await db.prepare('SELECT id FROM prospect_sequences WHERE id=?1').bind(sid).first())) fail(404, 'Sequence not found');
  const ids = input?.person_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 20 || !ids.every((x) => Number.isInteger(x) && x > 0)) fail(400, 'Choose 1 to 20 people');
  const { results } = await db.prepare(`SELECT id FROM people WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL`).bind(JSON.stringify(ids)).all();
  if (results.length !== new Set(ids).size) fail(400, 'A selected person was not found');
  await db.batch(ids.map((personId) => db.prepare(`INSERT OR IGNORE INTO prospect_enrollments(sequence_id,person_id,state,created_at)
    VALUES (?1,?2,'planned',?3)`).bind(sid, personId, nowIso())));
  const total = await db.prepare('SELECT count(*) AS n FROM prospect_enrollments WHERE sequence_id=?1').bind(sid).first();
  return { planned: total.n, sending_enabled: false };
}

export async function plannedPeople(db, id) {
  const sid = positiveId(id);
  if (!(await db.prepare('SELECT id FROM prospect_sequences WHERE id=?1').bind(sid).first())) fail(404, 'Sequence not found');
  const { results } = await db.prepare(`SELECT e.person_id,e.state,p.name FROM prospect_enrollments e JOIN people p ON p.id=e.person_id
    WHERE e.sequence_id=?1 AND p.deleted_at IS NULL ORDER BY p.name COLLATE NOCASE LIMIT 500`).bind(sid).all();
  return results;
}

export async function setPlanState(db, sequenceId, personId, input) {
  const state = input?.state;
  if (!['planned', 'paused', 'complete'].includes(state)) fail(400, 'Choose planned, paused or complete');
  const result = await db.prepare('UPDATE prospect_enrollments SET state=?3 WHERE sequence_id=?1 AND person_id=?2 RETURNING person_id,state')
    .bind(positiveId(sequenceId), positiveId(personId), state).first();
  if (!result) fail(404, 'Planned person not found');
  return { ...result, sending_enabled: false };
}

export async function evidence(db, kind, recordId) {
  const k = kindOf(kind), id = positiveId(recordId);
  const { results } = await db.prepare('SELECT field,source,source_url,observed_at,status,detail FROM prospect_evidence WHERE kind=?1 AND record_id=?2 ORDER BY observed_at DESC').bind(k, id).all();
  return results;
}

/** Five records per request keeps each invocation below D1 Free's query ceiling. */
export async function transferBatch(db, input) {
  const kind = kindOf(input?.kind), records = input?.records;
  if (!Array.isArray(records) || !records.length || records.length > 5) fail(400, 'Transfer 1 to 5 records per request');
  const result = { added: 0, existing: 0, skipped: 0, reasons: [] };
  for (const raw of records) {
    const data = raw?.data || raw;
    const name = trim(data?.full_name || data?.name, 500);
    const email = trim(data?.email, 320).toLowerCase();
    const companyDomain = domain(data?.domain || data?.website);
    if (!name || (kind === 'people' && !email) || (kind === 'companies' && !companyDomain)) {
      result.skipped++; result.reasons.push('A record needs a name and a deduplication key'); continue;
    }
    const existing = kind === 'people'
      ? await db.prepare('SELECT id FROM people WHERE lower(email)=?1 AND deleted_at IS NULL LIMIT 1').bind(email).first()
      : await db.prepare('SELECT id FROM companies WHERE lower(domain)=?1 AND deleted_at IS NULL LIMIT 1').bind(companyDomain).first();
    let id = existing?.id;
    if (id) result.existing++;
    else {
      const payload = kind === 'people'
        ? { name, email, title: trim(data.title, 500), city: trim(data.city, 500), source: trim(raw?.source || 'Imported file', 120) }
        : { name, domain: companyDomain, industry: trim(data.industry, 500), city: trim(data.city, 500) };
      id = (await createRecord(db, kind, payload)).id;
      result.added++;
    }
    const fields = kind === 'people' ? ['full_name', 'email', 'title', 'city'] : ['name', 'domain', 'industry', 'city'];
    const sources = raw?.sources && typeof raw.sources === 'object' ? raw.sources : {};
    const entries = fields.filter((field) => data[field] && sources[field]?.source)
      .map((field) => ({ field: field === 'full_name' ? 'name' : field, ...sources[field] }));
    if (!entries.length) entries.push({ field: 'record', source: raw?.source, at: raw?.observed_at });
    for (const item of entries) {
      const at = observedAt(item.at);
      await db.prepare(`INSERT INTO prospect_evidence(kind,record_id,field,source,source_url,observed_at,status,detail)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
        ON CONFLICT(kind,record_id,field,source) DO UPDATE SET
        source_url=coalesce(excluded.source_url,prospect_evidence.source_url),
        observed_at=CASE WHEN excluded.status='unknown' THEN prospect_evidence.observed_at ELSE excluded.observed_at END,
        status=CASE WHEN excluded.status='unknown' THEN prospect_evidence.status ELSE excluded.status END,
        detail=CASE WHEN excluded.status='unknown' THEN prospect_evidence.detail ELSE excluded.detail END`)
        .bind(kind, id, item.field, trim(item.source || 'Imported file', 120), sourceUrl(item.url), at || nowIso(),
          at ? 'observed' : 'unknown', at ? `Value at observation: ${trim(data[item.field === 'name' && kind === 'people' ? 'full_name' : item.field], 500)}`
            : 'Original observation time unavailable').run();
    }
  }
  return result;
}

export async function costs(db) {
  const { results } = await db.prepare('SELECT * FROM prospect_costs ORDER BY created_at DESC LIMIT 100').all();
  return results;
}
