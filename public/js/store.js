/**
 * App state. Every record of every object is held in memory (a small-team CRM is thousands of
 * rows, which is a few hundred KB), so views filter and sort instantly and relations resolve
 * without extra requests.
 *
 * Writes are optimistic: the change shows at once, the request runs, and on failure the old value
 * comes back with an error toast. Moves and deletes offer Undo.
 */

import { api } from './api.js';
import { ALL_OBJECTS, OBJECTS, fieldsFor } from './schema.js';
import { todayISO } from './logic.js';
import { toast } from './ui/overlay.js';

export const state = {
  meta: { stages: [], fields: [], views: [], settings: {} },
  rows: {}, byId: {},
  nav: null,          // {object, ids}: the list a record was opened from, for ↑ ↓
  activityRev: 0,     // bumps after every write so open timelines refetch
};

const subs = new Set();
export const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
let queued = false;
export function changed() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; for (const fn of subs) fn(); });
}

function setRows(object, rows) {
  state.rows[object] = rows;
  state.byId[object] = new Map(rows.map((r) => [r.id, r]));
}

function put(object, row) {
  const list = state.rows[object];
  const i = list.findIndex((r) => r.id === row.id);
  if (i >= 0) list[i] = row; else list.unshift(row);
  state.byId[object].set(row.id, row);
}

function drop(object, id) {
  state.rows[object] = state.rows[object].filter((r) => r.id !== id);
  state.byId[object].delete(id);
}

export async function loadAll() {
  const [meta, ...lists] = await Promise.all([api.get('/bootstrap'), ...ALL_OBJECTS.map((o) => api.get('/' + o))]);
  state.meta = meta;
  ALL_OBJECTS.forEach((o, i) => setRows(o, lists[i]));
  recomputeDealTasks();
  applyAppearance();
}

export async function reload(object) {
  setRows(object, await api.get('/' + object));
  if (object === 'deals' || object === 'tasks') recomputeDealTasks();
  changed();
}

/* ---------------------------------------------------------------- derived */

let stageCache = { src: null, map: new Map() };
export function stagesMap() {
  if (stageCache.src !== state.meta.stages) stageCache = { src: state.meta.stages, map: new Map(state.meta.stages.map((s) => [s.key, s])) };
  return stageCache.map;
}

/** Everything the formatting and filtering functions need to turn ids into names. */
export function ctx() {
  const s = state.meta.settings;
  return {
    companies: state.byId.companies || new Map(), people: state.byId.people || new Map(), deals: state.byId.deals || new Map(),
    stages: stagesMap(), currency: s.currency || 'USD', dateFormat: s.date_format || 'mdy', today: todayISO(),
  };
}

export const fields = (object) => fieldsFor(object, state.meta.fields);
export const viewsFor = (object) => state.meta.views.filter((v) => v.object === object).sort((a, b) => a.position - b.position || a.id - b.id);
export const setting = (k, fallback) => state.meta.settings[k] ?? fallback;

export function recordName(object, id) {
  const r = state.byId[object]?.get(Number(id));
  return r ? (r[OBJECTS[object].primary] || 'Untitled') : null;
}

/** Deal cards flag "no next step" from the tasks already in memory, so ticking a task updates the board at once. */
export function recomputeDealTasks() {
  if (!state.rows.deals || !state.rows.tasks) return;
  const open = new Map();
  for (const t of state.rows.tasks) {
    if (t.record_type !== 'deals' || t.done_at) continue;
    const o = open.get(t.record_id) || { n: 0, due: null };
    o.n++; if (t.due_date && (!o.due || t.due_date < o.due)) o.due = t.due_date;
    open.set(t.record_id, o);
  }
  for (const d of state.rows.deals) {
    const o = open.get(d.id);
    d.open_tasks = o ? o.n : 0; d.next_due = o ? o.due : null;
  }
}

/* ---------------------------------------------------------------- appearance */

const media = window.matchMedia('(prefers-color-scheme: dark)');
export function applyAppearance() {
  const s = state.meta.settings;
  const pref = localStorage.getItem('crm.theme') || s.theme || 'system';
  const theme = pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.accent = s.accent || 'mono';
}
media.addEventListener('change', applyAppearance);

/* ---------------------------------------------------------------- record writes */

function applyLocal(object, row, patch) {
  const next = { ...row, extra: { ...(row.extra || {}) } };
  const custom = new Set(fields(object).filter((f) => f.custom).map((f) => f.key));
  for (const [k, v] of Object.entries(patch)) {
    if (custom.has(k)) next.extra[k] = v;
    else if (k === 'done') next.done_at = v ? new Date().toISOString() : null;
    else next[k] = v;
  }
  if (object === 'deals' && 'stage' in patch && patch.stage !== row.stage) next.stage_changed_at = new Date().toISOString();
  return next;
}

function inverse(object, before, patch) {
  const custom = new Set(fields(object).filter((f) => f.custom).map((f) => f.key));
  const out = {};
  for (const k of Object.keys(patch)) out[k] = custom.has(k) ? (before.extra || {})[k] ?? null : k === 'done' ? !!before.done_at : before[k] ?? null;
  return out;
}

function afterWrite(object) {
  state.activityRev++;
  if (object === 'tasks' || object === 'deals') recomputeDealTasks();
  changed();
}

const keepComputed = (before, row) => (before && 'open_tasks' in before ? { ...row, open_tasks: before.open_tasks, next_due: before.next_due } : row);

export async function createRecord(object, data) {
  const row = await api.post('/' + object, data).catch((e) => { toast(e.message, { error: true }); throw e; });
  put(object, object === 'deals' ? { ...row, open_tasks: 0, next_due: null } : row);
  afterWrite(object);
  return row;
}

export async function updateRecord(object, id, patch, { undoLabel } = {}) {
  const before = state.byId[object]?.get(id);
  if (!before) return null;
  put(object, applyLocal(object, before, patch));
  afterWrite(object);
  try {
    const row = await api.patch(`/${object}/${id}`, patch);
    put(object, keepComputed(before, row));
    afterWrite(object);
    if (undoLabel) toast(undoLabel, { action: 'Undo', onAction: () => updateRecord(object, id, inverse(object, before, patch)) });
    return row;
  } catch (e) {
    put(object, before); afterWrite(object);
    toast(e.message, { error: true });
    throw e;
  }
}

export async function deleteRecord(object, id, { quiet = false } = {}) {
  const before = state.byId[object]?.get(id);
  if (!before) return;
  drop(object, id); afterWrite(object);
  try {
    await api.del(`/${object}/${id}`);
    if (!quiet) {
      toast(`Deleted ${before[OBJECTS[object].primary] || OBJECTS[object].singular.toLowerCase()}`, {
        action: 'Undo', onAction: async () => { put(object, keepComputed(before, await api.post(`/${object}/${id}/restore`))); afterWrite(object); },
      });
    }
  } catch (e) {
    put(object, before); afterWrite(object);
    toast(e.message, { error: true });
  }
}

export async function bulkUpdate(object, ids, patch, label) {
  const befores = ids.map((id) => state.byId[object].get(id)).filter(Boolean);
  for (const b of befores) put(object, applyLocal(object, b, patch));
  afterWrite(object);
  try {
    await api.post(`/${object}/bulk`, { ids, patch });
    await reload(object);
    toast(label || `Updated ${ids.length}`, { action: 'Undo', onAction: async () => {
      for (const b of befores) await api.patch(`/${object}/${b.id}`, inverse(object, b, patch)).catch(() => {});
      await reload(object);
    } });
  } catch (e) {
    for (const b of befores) put(object, b);
    afterWrite(object);
    toast(e.message, { error: true });
  }
}

export async function bulkDelete(object, ids) {
  const befores = ids.map((id) => state.byId[object].get(id)).filter(Boolean);
  for (const b of befores) drop(object, b.id);
  afterWrite(object);
  try {
    await api.post(`/${object}/bulk`, { ids, action: 'delete' });
    toast(`Deleted ${ids.length} ${ids.length === 1 ? OBJECTS[object].singular.toLowerCase() : OBJECTS[object].plural.toLowerCase()}`, {
      action: 'Undo', onAction: async () => { await api.post(`/${object}/bulk`, { ids, action: 'restore' }); await reload(object); },
    });
  } catch (e) {
    for (const b of befores) put(object, b);
    afterWrite(object);
    toast(e.message, { error: true });
  }
}

export const fetchActivity = (type, id, limit = 60) =>
  api.get(type ? `/activity?type=${type}&id=${id}&limit=${limit}` : `/activity?limit=${limit}`);

/* ---------------------------------------------------------------- meta writes */

export async function saveSettings(patch) {
  const prev = state.meta.settings;
  state.meta.settings = { ...prev, ...patch };
  applyAppearance(); changed();
  try {
    state.meta.settings = await api.patch('/settings', patch);
  } catch (e) {
    state.meta.settings = prev; applyAppearance(); changed();
    toast(e.message, { error: true });
  }
}

export async function createView(data) {
  const v = await api.post('/views', data);
  state.meta.views.push(v); changed();
  return v;
}

export async function updateView(id, patch) {
  const i = state.meta.views.findIndex((v) => v.id === id);
  const prev = state.meta.views[i];
  if (i >= 0) state.meta.views[i] = { ...prev, ...patch }; changed();
  try {
    const v = await api.patch(`/views/${id}`, patch);
    state.meta.views[i] = v; changed();
    return v;
  } catch (e) {
    if (i >= 0) state.meta.views[i] = prev;
    changed(); toast(e.message, { error: true }); throw e;
  }
}

export async function deleteView(id) {
  await api.del(`/views/${id}`).catch((e) => { toast(e.message, { error: true }); throw e; });
  state.meta.views = state.meta.views.filter((v) => v.id !== id); changed();
}

export async function saveStages(stages, moves) {
  state.meta.stages = await api.put('/stages', { stages, moves });
  await reload('deals');
}

export async function createField(data) {
  const f = await api.post('/fields', data);
  state.meta.fields.push(f); changed();
  return f;
}

export async function updateField(id, patch) {
  const f = await api.patch(`/fields/${id}`, patch);
  state.meta.fields = state.meta.fields.map((x) => (x.id === id ? f : x)); changed();
  return f;
}

export async function deleteField(id) {
  const f = state.meta.fields.find((x) => x.id === id);
  await api.del(`/fields/${id}`);
  state.meta.fields = state.meta.fields.filter((x) => x.id !== id);
  if (f) await reload(f.object);
  changed();
}
