/** Settings: general, appearance, pipeline, fields, formats, data and keyboard shortcuts. */

import { h, mount } from '../dom.js';
import { icon, typeIcon } from '../icons.js';
import { OBJECTS, RECORD_OBJECTS, CUSTOM_TYPES, COLORS, fieldsFor } from '../schema.js';
import { fmtDate, fmtMoney, todayISO } from '../logic.js';
import { api } from '../api.js';
import { state, saveSettings, saveStages, createField, updateField, deleteField, changed, applyAppearance, loadAll } from '../store.js';
import { nav } from '../nav.js';
import { listbox, popover, modal, toast, confirmDialog } from '../ui/overlay.js';
import { openImport, exportCsv } from '../ui/importer.js';

export const SECTIONS = [
  ['general', 'General', 'sliders'], ['appearance', 'Appearance', 'palette'], ['pipeline', 'Pipeline', 'board'],
  ['fields', 'Fields', 'columns'], ['formats', 'Formats', 'calendar'], ['data', 'Import & export', 'database'], ['shortcuts', 'Keyboard shortcuts', 'keyboard'],
];

const draft = { stages: null, fieldsObject: 'people' };

export function renderSettings({ top, toolbar, content }, route) {
  toolbar.hidden = true;
  const section = SECTIONS.find(([k]) => k === route.section) ? route.section : 'general';
  const [, label, ic] = SECTIONS.find(([k]) => k === section);
  if (route.query.object && RECORD_OBJECTS.includes(route.query.object)) draft.fieldsObject = route.query.object;
  mount(top, h('button', { class: 'btn ghost icon menu-btn', 'aria-label': 'Menu', onClick: () => document.querySelector('.app').classList.toggle('side-open') }, icon('sidebar', 16)),
    h('div', { class: 'title' }, h('span', { class: 'crumb' }, 'Settings'), h('span', { class: 'faint' }, '/'), label));
  const wrap = h('div', { class: 'set-wrap' });
  ({ general, appearance, pipeline, fields, formats, data, shortcuts })[section](wrap);
  mount(content, wrap);
}

const head = (wrap, title, lead) => wrap.append(h('h1', null, title), h('p', { class: 'lead' }, lead));
const sect = (title, text, ...body) => h('section', { class: 'set-sect' }, h('h2', null, title), text ? h('p', null, text) : null, body);
const seg = (options, value, onPick) => h('div', { class: 'seg-ctl', role: 'radiogroup' }, options.map(([v, l]) =>
  h('button', { class: v === value ? 'on' : null, role: 'radio', 'aria-checked': v === value ? 'true' : 'false', onClick: () => onPick(v) }, l)));

/* ---------------------------------------------------------------- general */

function general(wrap) {
  const s = state.meta.settings;
  head(wrap, 'General', 'The basics of this workspace.');
  const name = h('input', { class: 'input', value: s.workspace_name || '', placeholder: 'My CRM', 'aria-label': 'Workspace name', style: { maxWidth: '320px' } });
  const save = () => { const v = name.value.trim(); if (v && v !== s.workspace_name) saveSettings({ workspace_name: v }).then(() => toast('Saved')); };
  name.addEventListener('blur', save);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
  wrap.append(
    sect('Workspace name', 'Shown at the top of the sidebar.', name),
    sect('Open records in', 'A side panel keeps the list in view; a full page gives the record the whole screen. Either way, the expand button switches.',
      seg([['panel', 'Side panel'], ['page', 'Full page']], s.record_open || 'panel', (v) => saveSettings({ record_open: v }))),
    sect('Password', 'The password is a Cloudflare secret, so it is changed from your terminal, never stored in this app. Changing it signs everyone out.',
      h('code', { style: { display: 'block', padding: '10px 12px', borderRadius: 'var(--r)', background: 'var(--bg-sunken)', fontSize: 'var(--fs-sm)' } }, 'npx wrangler secret put CRM_PASSWORD')));
}

/* ---------------------------------------------------------------- appearance */

const ACCENTS = [['mono', 'var(--ink)'], ['blue', '#2f6fed'], ['violet', '#7050f0'], ['green', '#178a55'], ['amber', '#c7810b'], ['red', '#d93c41'], ['pink', '#c9358f'], ['teal', '#0e8584']];

function appearance(wrap) {
  const s = state.meta.settings;
  let pref = 'system';
  try { pref = localStorage.getItem('crm.theme') || s.theme || 'system'; } catch {}
  head(wrap, 'Appearance', 'How the app looks on this device, and the accent colour for everyone.');
  const setTheme = (t) => { try { localStorage.setItem('crm.theme', t); } catch {} saveSettings({ theme: t }); applyAppearance(); changed(); };
  wrap.append(
    sect('Theme', 'System follows your computer’s light or dark setting.',
      h('div', { class: 'theme-tiles', role: 'radiogroup' }, [['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'System', 'monitor']].map(([k, l, ic]) =>
        h('button', { class: ['theme-tile', pref === k && 'on'], role: 'radio', 'aria-checked': pref === k ? 'true' : 'false', onClick: () => setTheme(k) },
          h('div', { class: ['prev', k] }, h('i'), h('i')), h('span', null, icon(ic, 14), l))))),
    sect('Accent colour', 'Used for primary buttons and selection. Mono is black on light and white on dark.',
      h('div', { class: 'swatches', role: 'radiogroup' }, ACCENTS.map(([k, color]) => h('button', {
        class: ['swatch', (s.accent || 'mono') === k && 'on'], style: { '--sw': color }, role: 'radio', 'aria-label': k, title: k,
        'aria-checked': (s.accent || 'mono') === k ? 'true' : 'false', onClick: () => saveSettings({ accent: k }),
      }, (s.accent || 'mono') === k ? icon('check', 13, 2.5) : null)))));
}

/* ---------------------------------------------------------------- pipeline */

function colorPicker(anchor, current, onPick) {
  popover(anchor, (el, pop) => {
    el.append(h('div', { class: 'pop-body' }, h('div', { class: 'swatches' }, COLORS.map((c) => h('button', {
      class: ['swatch', c === current && 'on'], 'data-c': c, style: { '--sw': 'var(--c)' }, 'aria-label': c, title: c,
      onClick: () => { pop.close(); onPick(c); },
    })))));
  }, { width: 250 });
}

function pipeline(wrap) {
  head(wrap, 'Pipeline', 'The stages a deal moves through, in order. Open stages are the pipeline; Won and Lost close a deal.');
  if (!draft.stages) draft.stages = state.meta.stages.map((s) => ({ ...s }));
  const list = draft.stages;
  const dirty = JSON.stringify(list.map(({ key, name, color, kind }) => ({ key, name, color, kind })))
    !== JSON.stringify(state.meta.stages.map(({ key, name, color, kind }) => ({ key, name, color, kind })));
  const counts = new Map(); for (const d of state.rows.deals || []) counts.set(d.stage, (counts.get(d.stage) || 0) + 1);
  let dragFrom = null;
  const rows = list.map((s, i) => {
    const nameInput = h('input', { value: s.name, 'aria-label': 'Stage name', placeholder: 'Stage name' });
    nameInput.addEventListener('input', () => { s.name = nameInput.value; });
    nameInput.addEventListener('blur', () => changed());
    const row = h('div', { class: 'le-row', draggable: 'true' },
      h('span', { class: 'grip', title: 'Drag to reorder' }, icon('grip', 15)),
      h('button', { class: 'btn ghost icon sm', 'aria-label': 'Colour', onClick: (e) => colorPicker(e.currentTarget, s.color, (c) => { s.color = c; changed(); }) }, h('span', { class: 'dot', 'data-c': s.color })),
      nameInput,
      h('span', { class: 'faint num', style: { fontSize: 'var(--fs-sm)', whiteSpace: 'nowrap' } }, s.key && counts.get(s.key) ? `${counts.get(s.key)} deal${counts.get(s.key) === 1 ? '' : 's'}` : ''),
      h('button', { class: 'btn ghost sm', onClick: (e) => listbox(e.currentTarget, { search: false, width: 160, items: [['open', 'Open'], ['won', 'Won'], ['lost', 'Lost']].map(([k, l]) => ({ label: l, checked: s.kind === k, onSelect: () => { s.kind = k; changed(); } })) }) },
        { open: 'Open', won: 'Won', lost: 'Lost' }[s.kind], icon('chevron-down', 12)),
      h('button', { class: 'btn ghost icon sm', 'aria-label': 'Move up', disabled: i === 0, onClick: () => { list.splice(i - 1, 0, list.splice(i, 1)[0]); changed(); } }, icon('arrow-up', 13)),
      h('button', { class: 'btn ghost icon sm', 'aria-label': 'Remove stage', onClick: () => { list.splice(i, 1); changed(); } }, icon('trash', 13)));
    row.addEventListener('dragstart', (e) => { dragFrom = i; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', (e) => { e.preventDefault(); if (dragFrom === null || dragFrom === i) return; list.splice(i, 0, list.splice(dragFrom, 1)[0]); dragFrom = null; changed(); });
    return row;
  });
  const save = async (moves = {}) => {
    try {
      await saveStages(list.map(({ key, name, color, kind }) => ({ key, name: name.trim(), color, kind })), moves);
      draft.stages = null; toast('Pipeline saved'); changed();
    } catch (e) {
      if (e.status === 409 && e.body?.needsMove) askMoves(e.body.needsMove, save);
      else toast(e.message, { error: true });
    }
  };
  const reasons = state.meta.settings.lost_reasons || [];
  const reasonInput = h('input', { class: 'input', placeholder: 'Add a reason and press Enter', style: { maxWidth: '320px' } });
  reasonInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = reasonInput.value.trim();
    if (v && !reasons.includes(v)) saveSettings({ lost_reasons: [...reasons, v] });
    reasonInput.value = '';
  });
  wrap.append(
    sect('Stages', 'Drag to reorder. Removing a stage that has deals asks where those deals should go.',
      h('div', { class: 'list-edit' }, rows),
      h('div', { class: 'row', style: { marginTop: '10px' } },
        h('button', { class: 'btn sm', onClick: () => { list.splice(Math.max(0, list.findIndex((s) => s.kind !== 'open')), 0, { key: null, name: 'New stage', color: 'gray', kind: 'open' }); changed(); } }, icon('plus', 13), 'Add stage'),
        h('span', { class: 'grow' }),
        dirty ? h('button', { class: 'btn ghost sm', onClick: () => { draft.stages = null; changed(); } }, 'Discard') : null,
        h('button', { class: 'btn primary sm', disabled: !dirty, onClick: () => save() }, 'Save pipeline'))),
    sect('Lost reasons', 'Offered when a deal is marked lost, so you can see why deals slip away.',
      h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px', marginBottom: '10px' } }, reasons.map((r) => h('span', { class: 'pill', 'data-c': 'gray' }, r,
        h('button', { 'aria-label': `Remove ${r}`, onClick: () => saveSettings({ lost_reasons: reasons.filter((x) => x !== r) }) }, icon('x', 11))))),
      reasonInput));
}

function askMoves(needsMove, retry) {
  const keep = draft.stages.filter((s) => s.key);
  const moves = {};
  modal({
    title: 'Where should these deals go?', width: 460,
    body: (b) => {
      b.append(h('p', { class: 'muted', style: { margin: 0 } }, 'Some stages you removed still have deals. Pick a new stage for each.'));
      for (const [key, n] of Object.entries(needsMove)) {
        const old = state.meta.stages.find((s) => s.key === key);
        moves[key] = keep[0]?.key;
        const sel = h('select', { class: 'select' }, keep.map((s) => h('option', { value: s.key }, s.name)));
        sel.addEventListener('change', () => { moves[key] = sel.value; });
        b.append(h('div', { class: 'form-row' }, h('label', { class: 'label' }, `${n} deal${n === 1 ? '' : 's'} in “${old?.name || key}” move to`), sel));
      }
    },
    footer: (f, m) => f.append(h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: m.close }, 'Cancel'),
      h('button', { class: 'btn primary', onClick: () => { m.close(); retry(moves); } }, 'Move and save')),
  });
}

/* ---------------------------------------------------------------- fields */

function fields(wrap) {
  const object = draft.fieldsObject;
  head(wrap, 'Fields', 'Add your own fields to people, companies and deals. They show up in tables, filters, the record panel and CSV import and export.');
  const all = fieldsFor(object, state.meta.fields);
  const custom = all.filter((f) => f.custom);
  const system = all.filter((f) => !f.custom);
  const label = h('input', { class: 'input', placeholder: 'Field name, e.g. Lead score', 'aria-label': 'New field name' });
  let type = 'text'; const opts = [];
  const typeBtn = h('button', { class: 'btn', style: { flex: 'none' } });
  const optWrap = h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } });
  const renderNew = () => {
    mount(typeBtn, icon(typeIcon(type), 14), CUSTOM_TYPES.find((t) => t.type === type).label, icon('chevron-down', 12));
    mount(optWrap, type === 'select' ? [...opts.map((o, i) => h('span', { class: 'pill', 'data-c': o.color }, o.value, h('button', { 'aria-label': 'Remove option', onClick: () => { opts.splice(i, 1); renderNew(); } }, icon('x', 11)))),
      optInput] : null);
  };
  const optInput = h('input', { class: 'input', placeholder: 'Add an option and press Enter', style: { width: '240px' } });
  optInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = optInput.value.trim(); if (v) { opts.push({ value: v, color: COLORS[(opts.length + 1) % COLORS.length] }); optInput.value = ''; renderNew(); optInput.focus(); } } });
  typeBtn.addEventListener('click', () => listbox(typeBtn, { search: false, width: 200, items: CUSTOM_TYPES.map((t) => ({ label: t.label, icon: typeIcon(t.type, t.to), checked: t.type === type, onSelect: () => { type = t.type; renderNew(); } })) }));
  const add = async () => {
    const l = label.value.trim();
    if (!l) { label.focus(); return; }
    if (type === 'select' && !opts.length) { toast('Add at least one option', { error: true }); optInput.focus(); return; }
    try { await createField({ object, label: l, type, options: opts }); toast(`Added ${l}`); } catch (e) { toast(e.message, { error: true }); }
  };
  label.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  renderNew();

  wrap.append(
    h('div', { style: { marginBottom: '20px' } }, h('div', { class: 'seg-ctl' }, RECORD_OBJECTS.map((o) => h('button', { class: o === object ? 'on' : null, onClick: () => { draft.fieldsObject = o; nav.go('/settings/fields?object=' + o); } }, OBJECTS[o].plural)))),
    sect('New field', null, h('div', { class: 'row' }, label, typeBtn, h('button', { class: 'btn primary', onClick: add }, 'Add field')), optWrap),
    sect(`Custom fields · ${custom.length}`, custom.length ? null : 'None yet.',
      h('div', { class: 'list-edit' }, custom.map((f) => customRow(f)))),
    sect('Built-in fields', 'These come with every CRM and cannot be removed.',
      h('div', { class: 'list-edit' }, system.map((f) => h('div', { class: 'le-row' }, h('span', { class: 'faint', style: { padding: '0 4px' } }, icon(typeIcon(f.type, f.to), 15)),
        h('span', { class: 'grow', style: { padding: '6px 4px' } }, f.label), h('span', { class: 'pill' }, f.readonly ? 'Automatic' : 'System'))))));
}

function customRow(f) {
  const input = h('input', { value: f.label, 'aria-label': 'Field name' });
  input.addEventListener('blur', () => { const v = input.value.trim(); if (v && v !== f.label) updateField(f.id, { label: v }).then(() => toast('Renamed')).catch((e) => toast(e.message, { error: true })); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  return h('div', { class: 'stack', style: { gap: '4px' } },
    h('div', { class: 'le-row' },
      h('span', { class: 'faint', style: { padding: '0 4px' } }, icon(typeIcon(f.type, f.to), 15)), input,
      h('span', { class: 'pill' }, CUSTOM_TYPES.find((t) => t.type === f.type)?.label || f.type),
      f.type === 'select' ? h('button', { class: 'btn ghost sm', onClick: (e) => editOptions(e.currentTarget, f) }, `${f.options.length} options`) : null,
      h('button', { class: 'btn ghost icon sm', 'aria-label': `Delete ${f.label}`, onClick: async () => {
        if (await confirmDialog({ title: `Delete “${f.label}”?`, text: 'The field and every value stored in it are removed from all records. This cannot be undone.', confirmLabel: 'Delete field', danger: true })) {
          deleteField(f.id).then(() => toast('Field deleted')).catch((e) => toast(e.message, { error: true }));
        }
      } }, icon('trash', 13))));
}

function editOptions(anchor, f) {
  popover(anchor, (el, pop) => {
    const opts = f.options.map((o) => ({ ...o }));
    const list = h('div', { class: 'stack', style: { gap: '4px' } });
    const input = h('input', { class: 'input', placeholder: 'New option' });
    const render = () => mount(list, opts.map((o, i) => h('div', { class: 'row' },
      h('button', { class: 'btn ghost icon sm', onClick: (e) => colorPicker(e.currentTarget, o.color, (c) => { o.color = c; render(); }) }, h('span', { class: 'dot', 'data-c': o.color })),
      h('span', { class: 'grow' }, o.value),
      h('button', { class: 'btn ghost icon sm', 'aria-label': 'Remove', onClick: () => { opts.splice(i, 1); render(); } }, icon('x', 12)))));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = input.value.trim(); if (v) { opts.push({ value: v, color: 'gray' }); input.value = ''; render(); } } });
    render();
    el.append(h('div', { class: 'pop-body' }, list, input, h('button', { class: 'btn primary sm', onClick: async () => {
      pop.close();
      try { await updateField(f.id, { options: opts }); toast('Options saved'); } catch (e) { toast(e.message, { error: true }); }
    } }, 'Save options')));
  }, { width: 280 });
}

/* ---------------------------------------------------------------- formats */

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'TRY', 'AED', 'SAR', 'INR', 'PKR', 'MYR', 'IDR', 'JPY', 'CHF', 'SEK', 'NGN', 'EGP', 'ZAR', 'BRL', 'MXN'];

function formats(wrap) {
  const s = state.meta.settings;
  head(wrap, 'Formats', 'How money and dates are shown everywhere in the app.');
  const cur = h('select', { class: 'select', style: { maxWidth: '220px' }, 'aria-label': 'Currency' }, CURRENCIES.map((c) => h('option', { value: c, selected: c === (s.currency || 'USD') }, c)));
  cur.addEventListener('change', () => saveSettings({ currency: cur.value }));
  const today = todayISO();
  wrap.append(
    sect('Currency', `Deal values show as ${fmtMoney(1250000, s.currency || 'USD')}.`, cur),
    sect('Date format', null, seg([['mdy', fmtDate(today, 'mdy')], ['dmy', fmtDate(today, 'dmy')], ['iso', fmtDate(today, 'iso')]], s.date_format || 'mdy', (v) => saveSettings({ date_format: v }))),
    sect('Week starts on', null, seg([['sunday', 'Sunday'], ['monday', 'Monday']], s.week_start || 'sunday', (v) => saveSettings({ week_start: v }))));
}

/* ---------------------------------------------------------------- data */

function data(wrap) {
  head(wrap, 'Import & export', 'Bring your contacts in from anywhere, and take everything out whenever you like. It is your data.');
  wrap.append(
    sect('Import from CSV', 'HubSpot, Pipedrive, Google Contacts and spreadsheet exports work as they are. Companies named in a file are matched or created.',
      h('div', { class: 'row' }, RECORD_OBJECTS.map((o) => h('button', { class: 'btn', onClick: () => openImport(o) }, icon('upload', 14), OBJECTS[o].plural)))),
    sect('Export to CSV', 'Every field, custom fields included, with names instead of ids. Safe to open in Excel.',
      h('div', { class: 'row' }, RECORD_OBJECTS.map((o) => h('button', { class: 'btn', onClick: () => exportCsv(o) }, icon('download', 14), OBJECTS[o].plural)))),
    sect('Danger zone', null, h('div', { class: 'danger-box' },
      h('div', null, h('b', null, 'Delete all records'), h('div', { class: 'muted' }, 'People, companies, deals, tasks, notes and history. Settings, fields, views and the pipeline stay.')),
      h('button', { class: 'btn danger', onClick: wipe }, 'Delete everything'))));
}

function wipe() {
  modal({
    title: 'Delete every record?', width: 440,
    body: (b) => {
      b.append(h('p', { class: 'muted', style: { margin: 0 } }, 'This removes all people, companies, deals, tasks, notes and history for good. Export first if you might want them. Type DELETE to confirm.'),
        h('input', { class: 'input', placeholder: 'DELETE', 'aria-label': 'Type DELETE to confirm' }));
    },
    footer: (f, m) => f.append(h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: m.close }, 'Cancel'),
      h('button', { class: 'btn danger solid', onClick: async () => {
        const v = m.el.querySelector('input').value;
        try { await api.del('/data', { confirm: v }); m.close(); await loadAll(); changed(); toast('All records deleted'); } catch (e) { toast(e.message, { error: true }); }
      } }, 'Delete everything')),
  });
}

/* ---------------------------------------------------------------- shortcuts */

export const SHORTCUTS = [
  ['Open the command menu', ['Ctrl', 'K']], ['Show this list', ['?']], ['Search this list', ['/']],
  ['New record on this page', ['C']], ['New deal', ['D']], ['New task', ['T']], ['New note', ['N']],
  ['Go to Home', ['G', 'H']], ['Go to People', ['G', 'P']], ['Go to Companies', ['G', 'C']], ['Go to Deals', ['G', 'D']],
  ['Go to Tasks', ['G', 'T']], ['Go to Notes', ['G', 'N']], ['Go to Settings', ['G', 'S']],
  ['Move through rows or records', ['↑', '↓']], ['Open the highlighted row', ['Enter']], ['Select the highlighted row', ['X']],
  ['Pick up / drop a board card', ['Space']], ['Move a picked-up card', ['←', '→']], ['Save a form', ['Ctrl', 'Enter']], ['Close', ['Esc']],
];

export const keys = (list) => h('span', { class: 'keys' }, list.map((k) => h('kbd', null, k)));

function shortcuts(wrap) {
  head(wrap, 'Keyboard shortcuts', 'Everything can be done without the mouse. Press ? anywhere to see this list.');
  wrap.append(h('div', { class: 'sc-list' }, SHORTCUTS.map(([label, k]) => [h('span', null, label), keys(k)])));
}
