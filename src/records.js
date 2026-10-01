/**
 * One engine for every object. People, companies, deals, tasks and notes all go through the same
 * list / create / update / delete code, driven by the field definitions in public/js/schema.js.
 * Every write also records what changed in `activity`, which is what the record timeline shows.
 */

import { OBJECTS, RECORD_OBJECTS, fieldsFor, cleanRecord } from '../public/js/schema.js';
import { fmtDate } from '../public/js/logic.js';
import { nowIso, fail, parseJson } from './util.js';
import { parseCsv, csvCell, mapHeaders, toCents, MAX_IMPORT_ROWS } from './csv.js';

/** Database columns a write may touch, per object. Everything else is system-managed. */
const COLUMNS = {
  people: ['name', 'email', 'phone', 'title', 'company_id', 'city', 'linkedin', 'source', 'tags'],
  companies: ['name', 'domain', 'industry', 'employees', 'phone', 'city', 'tags'],
  deals: ['name', 'value_cents', 'stage', 'company_id', 'person_id', 'close_date', 'source', 'lost_reason'],
  tasks: ['title', 'due_date', 'done_at', 'record_type', 'record_id'],
  notes: ['title', 'body', 'record_type', 'record_id'],
};
const HAS_EXTRA = new Set(RECORD_OBJECTS);
const MAX_BULK = 500;

export function assertObject(object) {
  if (!OBJECTS[object]) fail(404, 'Unknown object');
}

export async function customFields(db) {
  const { results } = await db.prepare('SELECT * FROM fields ORDER BY object, position').all();
  return (results || []).map((f) => ({ ...f, options: parseJson(f.options, []) }));
}

const decorate = (row) => {
  if (!row) return row;
  if ('extra' in row) row.extra = parseJson(row.extra, {});
  return row;
};

const nameOf = (object, row) => String(row?.[OBJECTS[object].primary] || row?.name || row?.title || 'Untitled').slice(0, 200);

export function activityStmt(db, type, id, kind, label, data = {}, at = nowIso()) {
  return db.prepare('INSERT INTO activity (record_type, record_id, kind, label, data, created_at) VALUES (?1,?2,?3,?4,?5,?6)')
    .bind(type, id, kind, label ?? null, JSON.stringify(data), at);
}

async function loadRow(db, object, id) {
  const row = await db.prepare(`SELECT * FROM ${object} WHERE id=?1 AND deleted_at IS NULL`).bind(id).first();
  if (!row) fail(404, `${OBJECTS[object].singular} not found`);
  return row;
}

async function exists(db, object, id) {
  return !!(await db.prepare(`SELECT id FROM ${object} WHERE id=?1 AND deleted_at IS NULL`).bind(id).first());
}

/** Relations must point at live records, and a task or note may only hang off a real record. */
async function checkRefs(db, row) {
  if (row.company_id && !(await exists(db, 'companies', row.company_id))) fail(400, 'That company does not exist');
  if (row.person_id && !(await exists(db, 'people', row.person_id))) fail(400, 'That person does not exist');
  if ('record_type' in row || 'record_id' in row) {
    if (row.record_type == null && row.record_id == null) return;
    if (!RECORD_OBJECTS.includes(row.record_type)) fail(400, 'Tasks and notes attach to people, companies or deals');
    if (!row.record_id || !(await exists(db, row.record_type, row.record_id))) fail(400, 'The linked record does not exist');
  }
}

async function stageRow(db, key) {
  return db.prepare('SELECT * FROM stages WHERE key=?1').bind(key).first();
}

async function firstOpenStage(db) {
  const s = await db.prepare("SELECT key FROM stages WHERE kind='open' ORDER BY position LIMIT 1").first();
  if (!s) fail(409, 'Add at least one open stage in Settings > Pipeline');
  return s.key;
}

/* ---------------------------------------------------------------- read */

export async function listRecords(db, object) {
  assertObject(object);
  let sql = `SELECT * FROM ${object} WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 20000`;
  if (object === 'deals') {
    // The board flags open deals with no open task: Pipedrive's "every deal needs a next step".
    sql = `SELECT d.*,
      (SELECT count(*) FROM tasks t WHERE t.record_type='deals' AND t.record_id=d.id AND t.done_at IS NULL AND t.deleted_at IS NULL) AS open_tasks,
      (SELECT min(t.due_date) FROM tasks t WHERE t.record_type='deals' AND t.record_id=d.id AND t.done_at IS NULL AND t.deleted_at IS NULL) AS next_due
      FROM deals d WHERE d.deleted_at IS NULL ORDER BY d.updated_at DESC LIMIT 20000`;
  }
  const { results } = await db.prepare(sql).all();
  return (results || []).map(decorate);
}

export async function getRecord(db, object, id) {
  assertObject(object);
  return decorate(await loadRow(db, object, id));
}

/**
 * A record's timeline. A company's timeline also shows what happened to its people and deals; a
 * person's shows their deals, because that is where the story of an account actually lives.
 */
export async function listActivity(db, { type, id, limit = 50 } = {}) {
  limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  let stmt;
  if (type && id) {
    assertObject(type);
    let where = '(record_type=?1 AND record_id=?2)';
    if (type === 'companies') where += " OR (record_type='deals' AND record_id IN (SELECT id FROM deals WHERE company_id=?2)) OR (record_type='people' AND record_id IN (SELECT id FROM people WHERE company_id=?2))";
    if (type === 'people') where += " OR (record_type='deals' AND record_id IN (SELECT id FROM deals WHERE person_id=?2))";
    stmt = db.prepare(`SELECT * FROM activity WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit}`).bind(type, Number(id));
  } else {
    stmt = db.prepare(`SELECT * FROM activity ORDER BY created_at DESC, id DESC LIMIT ${limit}`);
  }
  const { results } = await stmt.all();
  return (results || []).map((a) => ({ ...a, data: parseJson(a.data, {}) }));
}

/* ---------------------------------------------------------------- write */

export async function createRecord(db, object, input, { at = nowIso(), custom } = {}) {
  assertObject(object);
  custom = custom || await customFields(db);
  const c = cleanRecord(object, input, { customFields: custom });
  if (!c.ok) fail(400, c.error);
  const row = c.row;
  if (object === 'tasks') { row.done_at = row.done ? at : null; delete row.done; }
  await checkRefs(db, row);
  if (object === 'deals') {
    if (!row.stage) row.stage = await firstOpenStage(db);
    else if (!(await stageRow(db, row.stage))) fail(400, 'Unknown stage');
    row.value_cents = row.value_cents ?? 0;
  }
  const cols = COLUMNS[object].filter((k) => k in row);
  const names = [...cols]; const vals = cols.map((k) => row[k]);
  if (HAS_EXTRA.has(object)) { names.push('extra'); vals.push(JSON.stringify(c.extra)); }
  if (object === 'deals') { names.push('stage_changed_at'); vals.push(at); }
  names.push('created_at', 'updated_at'); vals.push(at, at);
  const sql = `INSERT INTO ${object} (${names.join(',')}) VALUES (${names.map((_, i) => '?' + (i + 1)).join(',')}) RETURNING *`;
  const created = await db.prepare(sql).bind(...vals).first();
  const stmts = [activityStmt(db, object, created.id, 'created', nameOf(object, created), {}, at)];
  if ((object === 'tasks' || object === 'notes') && created.record_type) {
    stmts.push(activityStmt(db, created.record_type, created.record_id, object === 'tasks' ? 'task' : 'note',
      await parentName(db, created), { id: created.id, title: nameOf(object, created) }, at));
  }
  await db.batch(stmts);
  return decorate(created);
}

async function parentName(db, child) {
  const p = await db.prepare(`SELECT * FROM ${child.record_type} WHERE id=?1`).bind(child.record_id).first();
  return p ? nameOf(child.record_type, p) : null;
}

const short = (v) => (v === null || v === undefined ? null : typeof v === 'string' ? v.slice(0, 200) : v);

export async function updateRecord(db, object, id, input, { at = nowIso(), custom } = {}) {
  assertObject(object);
  const old = await loadRow(db, object, id);
  custom = custom || await customFields(db);
  const c = cleanRecord(object, input, { partial: true, customFields: custom });
  if (!c.ok) fail(400, c.error);
  const row = c.row;
  if (object === 'tasks' && 'done' in row) { row.done_at = row.done ? (old.done_at || at) : null; delete row.done; }
  await checkRefs(db, { ...row, ...(('record_type' in row || 'record_id' in row) ? { record_type: row.record_type ?? old.record_type, record_id: row.record_id ?? old.record_id } : {}) });

  const label = nameOf(object, { ...old, ...row });
  const stmts = []; const sets = []; const vals = [];
  const set = (k, v) => { sets.push(`${k}=?${vals.length + 1}`); vals.push(v); };

  if (object === 'deals' && 'stage' in row && row.stage !== old.stage) {
    if (!row.stage || !(await stageRow(db, row.stage))) fail(400, 'Unknown stage');
    set('stage', row.stage); set('stage_changed_at', at);
    stmts.push(activityStmt(db, object, id, 'stage', label, { from: old.stage, to: row.stage }, at));
  }
  for (const k of COLUMNS[object]) {
    if (!(k in row) || k === 'stage') continue;
    if (String(row[k] ?? '') === String(old[k] ?? '')) continue;
    set(k, row[k]);
    if (k === 'done_at') {
      if (old.record_type) stmts.push(activityStmt(db, old.record_type, old.record_id, 'task_done', await parentName(db, old), { id, title: old.title, done: !!row.done_at }, at));
      continue;
    }
    // A note's body is logged as "edited", not copied into the activity table on every keystroke save.
    const data = object === 'notes' && k === 'body' ? { field: k } : { field: k, from: short(old[k]), to: short(row[k]) };
    stmts.push(activityStmt(db, object, id, 'updated', label, data, at));
  }
  if (HAS_EXTRA.has(object) && Object.keys(c.extra).length) {
    const prev = parseJson(old.extra, {});
    const next = { ...prev, ...c.extra };
    const changed = Object.keys(c.extra).filter((k) => String(prev[k] ?? '') !== String(c.extra[k] ?? ''));
    if (changed.length) {
      set('extra', JSON.stringify(next));
      for (const k of changed) stmts.push(activityStmt(db, object, id, 'updated', label, { field: k, from: short(prev[k]), to: short(c.extra[k]) }, at));
    }
  }
  if (!sets.length) return decorate(old);
  set('updated_at', at);
  const upd = db.prepare(`UPDATE ${object} SET ${sets.join(',')} WHERE id=?${vals.length + 1} RETURNING *`).bind(...vals, id);
  const res = await db.batch([upd, ...stmts]);
  return decorate(res[0].results[0]);
}

export async function deleteRecord(db, object, id, { at = nowIso() } = {}) {
  assertObject(object);
  const old = await loadRow(db, object, id);
  const cutoff = new Date(Date.parse(at) - 30 * 86400000).toISOString();
  await db.batch([
    db.prepare(`UPDATE ${object} SET deleted_at=?1 WHERE id=?2`).bind(at, id),
    activityStmt(db, object, id, 'deleted', nameOf(object, old), {}, at),
    // Soft-deleted rows older than 30 days are gone for good.
    ...Object.keys(COLUMNS).map((t) => db.prepare(`DELETE FROM ${t} WHERE deleted_at IS NOT NULL AND deleted_at < ?1`).bind(cutoff)),
  ]);
  return { ok: true };
}

export async function restoreRecord(db, object, id, { at = nowIso() } = {}) {
  assertObject(object);
  const row = await db.prepare(`SELECT * FROM ${object} WHERE id=?1 AND deleted_at IS NOT NULL`).bind(id).first();
  if (!row) fail(404, 'Nothing to restore');
  const res = await db.batch([
    db.prepare(`UPDATE ${object} SET deleted_at=NULL, updated_at=?1 WHERE id=?2 RETURNING *`).bind(at, id),
    activityStmt(db, object, id, 'restored', nameOf(object, row), {}, at),
  ]);
  return decorate(res[0].results[0]);
}

export async function bulk(db, object, { ids, patch, action } = {}) {
  assertObject(object);
  if (!Array.isArray(ids) || !ids.length) fail(400, 'Pick at least one record');
  if (ids.length > MAX_BULK) fail(400, `At most ${MAX_BULK} records at a time`);
  const clean = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const custom = await customFields(db);
  const out = [];
  for (const id of clean) {
    if (action === 'delete') out.push(await deleteRecord(db, object, id).then(() => id).catch(() => null));
    else if (action === 'restore') out.push(await restoreRecord(db, object, id).then(() => id).catch(() => null));
    else if (patch && typeof patch === 'object') out.push(await updateRecord(db, object, id, patch, { custom }));
    else fail(400, 'Send a patch or an action');
  }
  return { ok: true, count: out.filter(Boolean).length, rows: out.filter((r) => r && typeof r === 'object') };
}

/* ---------------------------------------------------------------- CSV */

export async function importCsv(db, object, text) {
  if (!RECORD_OBJECTS.includes(object)) fail(400, 'Import people, companies or deals');
  const rows = parseCsv(text);
  if (rows.length < 2) fail(400, rows.length ? 'The file only has a header row' : 'The file is empty');
  const custom = await customFields(db);
  const cols = mapHeaders(object, rows[0], custom);
  if (!cols.some((c) => ['name', '_first', '_last', 'email'].includes(c))) fail(400, 'Need a name column (or an email column for people)');
  const at = nowIso();
  const body = rows.slice(1, MAX_IMPORT_ROWS + 1);

  // Companies named in the file are matched by name (any case) or created once, before the rows.
  const companies = new Map();
  for (const c of (await db.prepare('SELECT id, name FROM companies WHERE deleted_at IS NULL').all()).results || []) companies.set(c.name.toLowerCase(), c.id);
  const people = new Map();
  if (object === 'deals') for (const p of (await db.prepare('SELECT id, name FROM people WHERE deleted_at IS NULL').all()).results || []) people.set(p.name.toLowerCase(), p.id);
  const stages = (await db.prepare('SELECT * FROM stages ORDER BY position').all()).results || [];
  const defaultStage = stages.find((s) => s.kind === 'open')?.key;

  const parsed = body.map((r) => {
    const o = {};
    cols.forEach((c, i) => { if (c && r[i] !== undefined && r[i].trim() !== '') o[c] = r[i].trim(); });
    return o;
  });
  const newCompanies = [...new Map(parsed.map((o) => o._company).filter((n) => n && !companies.has(n.toLowerCase()))
    .map((n) => [n.toLowerCase(), n])).values()];
  for (let i = 0; i < newCompanies.length; i += 50) {
    const chunk = newCompanies.slice(i, i + 50);
    const res = await db.batch(chunk.map((n) => db.prepare("INSERT INTO companies (name, extra, created_at, updated_at) VALUES (?1,'{}',?2,?2) RETURNING id").bind(n.slice(0, 500), at)));
    res.forEach((r, j) => companies.set(chunk[j].toLowerCase(), r.results[0].id));
  }

  const ready = []; const errors = []; let skipped = 0;
  parsed.forEach((o, i) => {
    if (!Object.keys(o).length) return;
    const input = { ...o };
    if (object === 'people' && !input.name) input.name = [o._first, o._last].filter(Boolean).join(' ') || o.email;
    if (o._company) input.company_id = companies.get(o._company.toLowerCase());
    if (o._person) input.person_id = people.get(o._person.toLowerCase()) ?? undefined;
    if (object === 'deals') {
      if ('value_cents' in o) input.value_cents = toCents(o.value_cents);
      const st = o.stage && stages.find((s) => s.key === o.stage.toLowerCase() || s.name.toLowerCase() === o.stage.toLowerCase());
      input.stage = st ? st.key : defaultStage;
    }
    for (const f of custom.filter((f) => f.object === object && f.type === 'currency')) if (f.key in o) input[f.key] = toCents(o[f.key]);
    for (const k of Object.keys(input)) if (k.startsWith('_')) delete input[k];
    const c = cleanRecord(object, input, { customFields: custom });
    if (!c.ok) { skipped++; if (errors.length < 5) errors.push(`Row ${i + 2}: ${c.error}`); return; }
    ready.push({ row: c.row, extra: c.extra, note: o._notes || null });
  });

  let added = 0;
  for (let i = 0; i < ready.length; i += 50) {
    const chunk = ready.slice(i, i + 50);
    const res = await db.batch(chunk.map(({ row, extra }) => {
      const names = COLUMNS[object].filter((k) => k in row);
      const vals = names.map((k) => row[k]);
      names.push('extra', 'created_at', 'updated_at'); vals.push(JSON.stringify(extra), at, at);
      if (object === 'deals') { names.push('stage_changed_at'); vals.push(at); }
      return db.prepare(`INSERT INTO ${object} (${names.join(',')}) VALUES (${names.map((_, k) => '?' + (k + 1)).join(',')}) RETURNING id, ${OBJECTS[object].primary} AS label`).bind(...vals);
    }));
    const follow = [];
    res.forEach((r, j) => {
      const created = r.results[0]; if (!created) return;
      added++;
      follow.push(activityStmt(db, object, created.id, 'created', created.label, { via: 'import' }, at));
      if (chunk[j].note) follow.push(db.prepare('INSERT INTO notes (title, body, record_type, record_id, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?5)')
        .bind('Imported note', chunk[j].note.slice(0, 50000), object, created.id, at));
    });
    if (follow.length) await db.batch(follow);
  }
  return { added, skipped, errors, companiesCreated: object === 'companies' ? 0 : newCompanies.length, truncated: rows.length - 1 > MAX_IMPORT_ROWS };
}

export async function exportCsv(db, object, settings = {}) {
  if (!RECORD_OBJECTS.includes(object)) fail(400, 'Export people, companies or deals');
  const custom = await customFields(db);
  const fields = fieldsFor(object, custom);
  const rows = await listRecords(db, object);
  const names = async (t) => new Map(((await db.prepare(`SELECT id, name FROM ${t}`).all()).results || []).map((r) => [r.id, r.name]));
  const maps = { companies: await names('companies'), people: await names('people') };
  const stages = new Map(((await db.prepare('SELECT key, name FROM stages').all()).results || []).map((s) => [s.key, s.name]));
  const cell = (r, f) => {
    const v = f.custom ? r.extra?.[f.key] : r[f.key];
    if (v === null || v === undefined) return '';
    if (f.type === 'currency') return (Number(v) / 100).toFixed(2);
    if (f.type === 'relation') return maps[f.to].get(v) || '';
    if (f.type === 'stage') return stages.get(v) || v;
    if (f.type === 'date') return fmtDate(v, 'iso');
    if (f.type === 'checkbox') return v ? 'yes' : 'no';
    return v;
  };
  const lines = [fields.map((f) => csvCell(f.label)).join(',')]
    .concat(rows.map((r) => fields.map((f) => csvCell(cell(r, f))).join(',')));
  return lines.join('\r\n');
}
