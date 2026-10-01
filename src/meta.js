/** Workspace configuration: pipeline stages, custom fields, saved views and settings. */

import { RECORD_OBJECTS, CUSTOM_TYPES, COLORS, STAGE_KINDS } from '../public/js/schema.js';
import { nowIso, fail, parseJson, slug } from './util.js';
import { customFields } from './records.js';

const ACCENTS = ['mono', 'blue', 'violet', 'green', 'amber', 'red', 'pink', 'teal'];

/** Every setting a client may write, with its rule. Anything else is refused. */
const SETTING_RULES = {
  theme: (v) => ['light', 'dark', 'system'].includes(v),
  accent: (v) => ACCENTS.includes(v),
  currency: (v) => typeof v === 'string' && /^[A-Z]{3}$/.test(v),
  date_format: (v) => ['mdy', 'dmy', 'iso'].includes(v),
  week_start: (v) => ['sunday', 'monday'].includes(v),
  record_open: (v) => ['panel', 'page'].includes(v),
  lost_reasons: (v) => Array.isArray(v) && v.length <= 30 && v.every((s) => typeof s === 'string' && s.trim() && s.length <= 60),
  workspace_name: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 40,
};

export async function bootstrap(db) {
  const [stages, views, settings] = await Promise.all([
    db.prepare('SELECT * FROM stages ORDER BY position').all(),
    db.prepare('SELECT * FROM views ORDER BY object, position, id').all(),
    db.prepare('SELECT * FROM settings').all(),
  ]);
  return {
    stages: stages.results || [],
    fields: await customFields(db),
    views: (views.results || []).map((v) => ({ ...v, config: parseJson(v.config, {}) })),
    settings: Object.fromEntries((settings.results || []).map((s) => [s.key, parseJson(s.value, s.value)])),
  };
}

export async function patchSettings(db, input) {
  const entries = Object.entries(input || {});
  if (!entries.length) fail(400, 'Nothing to save');
  for (const [k, v] of entries) {
    if (!SETTING_RULES[k]) fail(400, `Unknown setting: ${k}`);
    if (!SETTING_RULES[k](v)) fail(400, `That value is not allowed for ${k}`);
  }
  await db.batch(entries.map(([k, v]) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .bind(k, JSON.stringify(typeof v === 'string' ? v.trim() : v))));
  return (await bootstrap(db)).settings;
}

/* ---------------------------------------------------------------- views */

function cleanView(input, partial) {
  const out = {};
  if (!partial || 'name' in input) {
    const name = String(input.name ?? '').trim().slice(0, 60);
    if (!name) fail(400, 'Give the view a name');
    out.name = name;
  }
  if (!partial || 'type' in input) {
    const type = input.type ?? 'table';
    if (!['table', 'board'].includes(type)) fail(400, 'A view is a table or a board');
    out.type = type;
  }
  if ('config' in input) {
    if (!input.config || typeof input.config !== 'object' || Array.isArray(input.config)) fail(400, 'Bad view config');
    const text = JSON.stringify(input.config);
    if (text.length > 20000) fail(400, 'View config is too large');
    out.config = text;
  }
  if ('position' in input) out.position = Math.max(0, Math.round(Number(input.position) || 0));
  return out;
}

export async function createView(db, input) {
  if (!RECORD_OBJECTS.includes(input?.object)) fail(400, 'Views belong to people, companies or deals');
  const v = cleanView(input, false);
  const pos = await db.prepare('SELECT coalesce(max(position), -1) + 1 AS p FROM views WHERE object=?1').bind(input.object).first();
  const row = await db.prepare('INSERT INTO views (object, name, type, config, position) VALUES (?1,?2,?3,?4,?5) RETURNING *')
    .bind(input.object, v.name, v.type, v.config || '{}', pos.p).first();
  return { ...row, config: parseJson(row.config, {}) };
}

export async function updateView(db, id, input) {
  const v = cleanView(input || {}, true);
  const keys = Object.keys(v);
  if (!keys.length) fail(400, 'Nothing to save');
  const row = await db.prepare(`UPDATE views SET ${keys.map((k, i) => `${k}=?${i + 1}`).join(',')} WHERE id=?${keys.length + 1} RETURNING *`)
    .bind(...keys.map((k) => v[k]), id).first();
  if (!row) fail(404, 'View not found');
  return { ...row, config: parseJson(row.config, {}) };
}

export async function deleteView(db, id) {
  const row = await db.prepare('SELECT object FROM views WHERE id=?1').bind(id).first();
  if (!row) fail(404, 'View not found');
  const n = await db.prepare('SELECT count(*) AS n FROM views WHERE object=?1').bind(row.object).first();
  if (n.n <= 1) fail(409, 'Every object keeps at least one view');
  await db.prepare('DELETE FROM views WHERE id=?1').bind(id).run();
  return { ok: true };
}

/* ---------------------------------------------------------------- stages */

/**
 * Replace the whole pipeline in one go (the settings page edits it as a list). A stage that still
 * has deals can only be removed if the request says where those deals move.
 */
export async function replaceStages(db, { stages, moves = {} } = {}) {
  if (!Array.isArray(stages) || !stages.length || stages.length > 20) fail(400, 'A pipeline has 1 to 20 stages');
  const seen = new Set();
  const clean = stages.map((s, i) => {
    const name = String(s.name ?? '').trim().slice(0, 40);
    if (!name) fail(400, 'Every stage needs a name');
    let key = s.key ? String(s.key) : slug(name);
    while (seen.has(key)) key = key + '_' + (i + 1);
    seen.add(key);
    const color = COLORS.includes(s.color) ? s.color : 'gray';
    const kind = STAGE_KINDS.includes(s.kind) ? s.kind : 'open';
    return { key, name, color, kind, position: i };
  });
  if (!clean.some((s) => s.kind === 'open')) fail(400, 'Keep at least one open stage');
  const old = (await db.prepare('SELECT key FROM stages').all()).results || [];
  const removed = old.map((s) => s.key).filter((k) => !seen.has(k));
  const needsMove = {};
  for (const k of removed) {
    const n = await db.prepare('SELECT count(*) AS n FROM deals WHERE stage=?1').bind(k).first();
    if (n.n > 0 && !seen.has(moves[k])) needsMove[k] = n.n;
  }
  if (Object.keys(needsMove).length) fail(409, 'Some removed stages still have deals. Choose where they move.', { needsMove });
  const at = nowIso();
  await db.batch([
    ...removed.filter((k) => seen.has(moves[k])).map((k) => db.prepare('UPDATE deals SET stage=?1, stage_changed_at=?2 WHERE stage=?3').bind(moves[k], at, k)),
    db.prepare('DELETE FROM stages'),
    ...clean.map((s) => db.prepare('INSERT INTO stages (key, name, color, kind, position) VALUES (?1,?2,?3,?4,?5)').bind(s.key, s.name, s.color, s.kind, s.position)),
  ]);
  return clean;
}

/* ---------------------------------------------------------------- custom fields */

function cleanOptions(options) {
  if (!Array.isArray(options)) fail(400, 'Options must be a list');
  if (options.length > 50) fail(400, 'At most 50 options');
  const seen = new Set();
  return options.map((o) => {
    const value = String(o?.value ?? o ?? '').trim().slice(0, 40);
    if (!value || seen.has(value.toLowerCase())) fail(400, 'Options must be unique and not empty');
    seen.add(value.toLowerCase());
    return { value, color: COLORS.includes(o?.color) ? o.color : 'gray' };
  });
}

export async function createField(db, input) {
  if (!RECORD_OBJECTS.includes(input?.object)) fail(400, 'Custom fields belong to people, companies or deals');
  const label = String(input.label ?? '').trim().slice(0, 40);
  if (!label) fail(400, 'Give the field a name');
  if (!CUSTOM_TYPES.some((t) => t.type === input.type)) fail(400, 'Unknown field type');
  const options = input.type === 'select' ? cleanOptions(input.options || []) : [];
  const key = 'cf_' + slug(label).slice(0, 24) + '_' + Math.random().toString(16).slice(2, 6);
  const pos = await db.prepare('SELECT coalesce(max(position), -1) + 1 AS p FROM fields WHERE object=?1').bind(input.object).first();
  const row = await db.prepare('INSERT INTO fields (object, key, label, type, options, position) VALUES (?1,?2,?3,?4,?5,?6) RETURNING *')
    .bind(input.object, key, label, input.type, JSON.stringify(options), pos.p).first();
  return { ...row, options };
}

export async function updateField(db, id, input = {}) {
  const f = await db.prepare('SELECT * FROM fields WHERE id=?1').bind(id).first();
  if (!f) fail(404, 'Field not found');
  const sets = []; const vals = [];
  if ('label' in input) {
    const label = String(input.label ?? '').trim().slice(0, 40);
    if (!label) fail(400, 'Give the field a name');
    sets.push('label'); vals.push(label);
  }
  if ('options' in input) {
    if (f.type !== 'select') fail(400, 'Only select fields have options');
    sets.push('options'); vals.push(JSON.stringify(cleanOptions(input.options)));
  }
  if ('position' in input) { sets.push('position'); vals.push(Math.max(0, Math.round(Number(input.position) || 0))); }
  if (!sets.length) fail(400, 'Nothing to save');
  const row = await db.prepare(`UPDATE fields SET ${sets.map((k, i) => `${k}=?${i + 1}`).join(',')} WHERE id=?${sets.length + 1} RETURNING *`)
    .bind(...vals, id).first();
  return { ...row, options: parseJson(row.options, []) };
}

export async function deleteField(db, id) {
  const f = await db.prepare('SELECT * FROM fields WHERE id=?1').bind(id).first();
  if (!f) fail(404, 'Field not found');
  await db.batch([
    db.prepare('DELETE FROM fields WHERE id=?1').bind(id),
    // Remove the value from every row too, so a deleted field leaves nothing behind.
    db.prepare(`UPDATE ${f.object} SET extra = json_remove(extra, '$.' || ?1)`).bind(f.key),
  ]);
  return { ok: true };
}

/* ---------------------------------------------------------------- danger zone */

export async function wipeData(db, { confirm } = {}) {
  if (confirm !== 'DELETE') fail(400, 'Type DELETE to confirm');
  await db.batch(['people', 'companies', 'deals', 'tasks', 'notes', 'activity'].map((t) => db.prepare(`DELETE FROM ${t}`)));
  return { ok: true };
}
