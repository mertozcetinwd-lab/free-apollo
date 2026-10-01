/**
 * An object's index page (People, Companies, Deals): saved views, sort and filter chips, search,
 * table or board, bulk actions. Sort and filters are drafts until "Save view"; column layout,
 * widths and calculations save straight away because they are how you like to look, not what
 * you are looking for.
 */

import { h, mount } from '../dom.js';
import { icon, typeIcon } from '../icons.js';
import { OBJECTS } from '../schema.js';
import { applyFilters, searchRows, sortRows, OPERATORS, operatorGroup, NO_VALUE_OPS, fmtDate, fmtMoney } from '../logic.js';
import { state, ctx, fields as fieldsOf, viewsFor, updateView, createView, deleteView, bulkUpdate, bulkDelete, updateRecord, stagesMap, setting, changed } from '../store.js';
import { nav } from '../nav.js';
import { listbox, menu, popover, modal } from '../ui/overlay.js';
import { pickValue } from '../ui/editors.js';
import { openImport, exportCsv } from '../ui/importer.js';
import { renderTable } from '../views/table.js';
import { renderBoard } from '../views/board.js';

const ui = {};
const DEFAULT_OP = { text: 'contains', number: 'gt', date: 'before', choice: 'is', checkbox: 'checked' };

function uiFor(object) {
  if (!ui[object]) {
    let viewId = null;
    try { viewId = Number(localStorage.getItem('crm.view.' + object)) || null; } catch {}
    ui[object] = { viewId, draft: null, search: '', selection: new Set(), limit: 200, focus: -1 };
  }
  return ui[object];
}

function currentView(object, st) {
  const views = viewsFor(object);
  const v = views.find((x) => x.id === st.viewId) || views[0];
  st.viewId = v?.id ?? null;
  return v;
}

export function renderList({ top, toolbar, content }, route) {
  const { object } = route;
  const def = OBJECTS[object];
  const st = uiFor(object);
  if (route.query.view && Number(route.query.view) !== st.viewId) { st.viewId = Number(route.query.view); st.draft = null; }
  const view = currentView(object, st);
  if (!view) { mount(content, h('div', { class: 'empty' }, h('h2', null, 'No views'))); return; }
  const saved = view.config || {};
  const cfg = { ...saved, ...(st.draft || {}) };
  const dirty = !!st.draft && (JSON.stringify(cfg.sort || null) !== JSON.stringify(saved.sort || null)
    || JSON.stringify(cfg.filters || []) !== JSON.stringify(saved.filters || []));
  const fields = fieldsOf(object);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const c = ctx();
  const all = state.rows[object] || [];
  let rows = applyFilters(all, cfg.filters || [], fields, c);
  rows = searchRows(rows, st.search, fields, c);
  rows = sortRows(rows, cfg.sort, fields, c);
  for (const id of st.selection) if (!state.byId[object].has(id)) st.selection.delete(id);

  const setDraft = (patch) => { st.draft = { sort: cfg.sort || null, filters: [...(cfg.filters || [])], ...patch }; changed(); };
  const saveLayout = (patch) => updateView(view.id, { config: { ...saved, ...patch } }).catch(() => {});
  const newRecord = (defaults) => nav.create(object, defaults);

  /* ---------------------------------------------------------------- top bar */
  mount(top,
    h('button', { class: 'btn ghost icon menu-btn', 'aria-label': 'Menu', onClick: () => document.querySelector('.app').classList.toggle('side-open') }, icon('sidebar', 16)),
    h('div', { class: 'title' }, h('span', { class: 'nav-ico', 'data-c': def.color }, icon(def.icon, 13, 2)), def.plural,
      h('span', { class: 'count num' }, rows.length === all.length ? all.length : `${rows.length} of ${all.length}`)),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn ghost icon', title: 'Import / export', 'aria-label': 'Import or export', onClick: (e) => menu(e.currentTarget, [
      { label: `Import ${def.plural.toLowerCase()} from CSV`, icon: 'upload', onSelect: () => openImport(object) },
      { label: 'Export to CSV', icon: 'download', onSelect: () => exportCsv(object) },
      { sep: true },
      { label: 'Manage fields', icon: 'sliders', onSelect: () => nav.go('/settings/fields?object=' + object) },
    ], { align: 'end' }) }, icon('more', 16)),
    h('button', { class: 'btn primary', onClick: () => newRecord() }, icon('plus', 14, 2.2), `New ${def.singular.toLowerCase()}`, h('kbd', null, 'C')));

  /* ---------------------------------------------------------------- toolbar */
  const viewBtn = h('button', { class: 'btn', onClick: (e) => viewMenu(e.currentTarget) },
    icon(view.type === 'board' ? 'board' : 'table', 15), h('span', { class: 'ellipsis', style: { maxWidth: '180px' } }, view.name), icon('chevron-down', 13));

  const viewMenu = (anchor) => {
    const views = viewsFor(object);
    listbox(anchor, {
      placeholder: 'Find a view…', width: 260,
      items: [
        { group: 'Views' },
        ...views.map((v) => ({ label: v.name, value: v.id, icon: v.type === 'board' ? 'board' : 'table', checked: v.id === view.id,
          onSelect: () => { st.viewId = v.id; st.draft = null; try { localStorage.setItem('crm.view.' + object, v.id); } catch {} nav.go(`/${object}?view=${v.id}`); } })),
        { sep: true },
        { label: 'New table view', icon: 'plus', onSelect: () => newView('table') },
        ...(object === 'deals' ? [{ label: 'New board view', icon: 'plus', onSelect: () => newView('board') }] : []),
        { label: 'Rename this view', icon: 'pencil', onSelect: renameView },
        { label: 'Duplicate this view', icon: 'copy', onSelect: () => newView(view.type, view.name + ' copy', cfg) },
        ...(views.length > 1 ? [{ label: 'Delete this view', icon: 'trash', danger: true, onSelect: async () => { await deleteView(view.id); st.viewId = null; nav.go('/' + object); } }] : []),
      ],
    });
  };
  const newView = (type, name, config) => nameDialog(`New ${type} view`, name || '', async (n) => {
    const v = await createView({ object, name: n, type, config: config || (type === 'board' ? { cardFields: ['company_id', 'close_date'] } : { columns: saved.columns }) });
    st.viewId = v.id; st.draft = null; nav.go(`/${object}?view=${v.id}`);
  });
  const renameView = () => nameDialog('Rename view', view.name, (n) => updateView(view.id, { name: n }));

  const sortChip = cfg.sort && byKey.get(cfg.sort.field)
    ? h('button', { class: 'chip', onClick: (e) => sortMenu(e.currentTarget) }, icon(cfg.sort.dir === 'desc' ? 'arrow-down' : 'arrow-up', 13, 2), 'Sorted by', h('b', null, byKey.get(cfg.sort.field).label))
    : h('button', { class: 'btn ghost sm', onClick: (e) => sortMenu(e.currentTarget) }, icon('sort', 14), 'Sort');
  const sortMenu = (anchor) => listbox(anchor, {
    placeholder: 'Sort by…',
    items: [
      { group: 'Direction' },
      { label: 'Ascending', icon: 'arrow-up', checked: (cfg.sort?.dir || 'asc') === 'asc', onSelect: () => setDraft({ sort: { field: cfg.sort?.field || def.primary, dir: 'asc' } }) },
      { label: 'Descending', icon: 'arrow-down', checked: cfg.sort?.dir === 'desc', onSelect: () => setDraft({ sort: { field: cfg.sort?.field || def.primary, dir: 'desc' } }) },
      { group: 'Field' },
      ...fields.map((f) => ({ label: f.label, icon: typeIcon(f.type, f.to), checked: cfg.sort?.field === f.key, onSelect: () => setDraft({ sort: { field: f.key, dir: cfg.sort?.dir || 'asc' } }) })),
      ...(cfg.sort ? [{ sep: true }, { label: 'Remove sort', icon: 'x', onSelect: () => setDraft({ sort: null }) }] : []),
    ],
  });

  const filters = cfg.filters || [];
  const setFilter = (i, patch) => { const next = filters.map((f, j) => (j === i ? { ...f, ...patch } : f)); setDraft({ filters: next }); };
  const removeFilter = (i) => setDraft({ filters: filters.filter((_, j) => j !== i) });
  const addFilter = (f) => {
    const group = operatorGroup(f.type);
    const next = [...filters, { field: f.key, op: DEFAULT_OP[group], value: '' }];
    // The next render opens the new chip's value picker, so choosing a field flows straight into its value.
    if (!NO_VALUE_OPS.includes(DEFAULT_OP[group])) st.openValue = next.length - 1;
    setDraft({ filters: next });
  };
  const filterValueText = (f, flt) => {
    const v = flt.value;
    if (v === '' || v === null || v === undefined) return null;
    if (f.type === 'stage') return stagesMap().get(v)?.name || v;
    if (f.type === 'relation') return state.byId[f.to]?.get(Number(v))?.name || '…';
    if (f.type === 'currency') return fmtMoney(Number(v) * 100, c.currency);
    if (['date', 'timestamp'].includes(f.type)) return fmtDate(v, c.dateFormat);
    return String(v);
  };
  const chips = filters.map((flt, i) => {
    const f = byKey.get(flt.field);
    if (!f) return null;
    const ops = OPERATORS[operatorGroup(f.type)];
    const opLabel = (ops.find(([k]) => k === flt.op) || ops[0])[1];
    const vt = filterValueText(f, flt);
    return h('div', { class: 'fchip' },
      h('button', { onClick: (e) => listbox(e.currentTarget, { placeholder: 'Filter by…', items: fields.map((x) => ({ label: x.label, icon: typeIcon(x.type, x.to), onSelect: () => setFilter(i, { field: x.key, op: DEFAULT_OP[operatorGroup(x.type)], value: '' }) })) }) },
        icon(typeIcon(f.type, f.to), 13), f.label),
      h('button', { class: 'op', onClick: (e) => listbox(e.currentTarget, { search: false, width: 200, items: ops.map(([k, l]) => ({ label: l, checked: k === flt.op, onSelect: () => setFilter(i, { op: k }) })) }) }, opLabel),
      NO_VALUE_OPS.includes(flt.op) ? null : h('button', {
        class: ['val', !vt && 'empty'],
        onClick: (e) => pickValue(e.currentTarget, f, flt.value, (v) => setFilter(i, { value: v ?? '' }), { cents: false }),
      }, h('span', { class: 'ellipsis' }, vt || 'Choose…')),
      h('button', { 'aria-label': 'Remove filter', onClick: () => removeFilter(i) }, icon('x', 13)));
  });
  const addFilterBtn = h('button', { class: 'btn ghost sm', onClick: (e) => listbox(e.currentTarget, {
    placeholder: 'Filter by…', items: fields.map((f) => ({ label: f.label, icon: typeIcon(f.type, f.to), onSelect: () => addFilter(f) })),
  }) }, icon('filter', 14), filters.length ? 'Add' : 'Filter');

  const search = h('input', { value: st.search, placeholder: 'Search', 'aria-label': `Search ${def.plural.toLowerCase()}`, id: 'list-search' });
  search.addEventListener('input', () => { st.search = search.value; st.limit = 200; changed(); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; st.search = ''; changed(); search.blur(); } });

  const settingsBtn = h('button', { class: 'btn ghost icon', title: 'View settings', 'aria-label': 'View settings', onClick: (e) => viewSettings(e.currentTarget) }, icon('sliders', 16));
  const viewSettings = (anchor) => {
    if (view.type === 'board') {
      const keys = cfg.cardFields || ['company_id', 'close_date'];
      listbox(anchor, {
        placeholder: 'Fields on cards…', align: 'end', keepOpen: false,
        items: [{ group: 'Show on cards' }, ...fields.filter((f) => !['name', 'stage', 'value_cents'].includes(f.key)).map((f) => ({
          label: f.label, icon: typeIcon(f.type, f.to), checked: keys.includes(f.key),
          onSelect: () => saveLayout({ cardFields: keys.includes(f.key) ? keys.filter((k) => k !== f.key) : [...keys, f.key] }),
        }))],
      });
    } else {
      const keys = (cfg.columns && cfg.columns.length ? cfg.columns : null) || fields.filter((f) => !f.readonly).slice(0, 6).map((f) => f.key);
      listbox(anchor, {
        placeholder: 'Columns…', align: 'end',
        items: [{ group: 'Columns' }, ...fields.map((f) => ({
          label: f.label, icon: typeIcon(f.type, f.to), checked: keys.includes(f.key) || f.key === def.primary,
          onSelect: () => { if (f.key === def.primary) return; saveLayout({ columns: keys.includes(f.key) ? keys.filter((k) => k !== f.key) : [...keys, f.key] }); },
        }))],
      });
    }
  };

  mount(toolbar,
    h('div', { class: 'tb-left' }, viewBtn, h('span', { class: 'vsep' }), sortChip, chips, addFilterBtn),
    h('div', { class: 'tb-right' }, dirty ? [
      h('button', { class: 'btn ghost sm', onClick: () => { st.draft = null; changed(); } }, 'Discard'),
      h('button', { class: 'btn sm', onClick: (e) => menu(e.currentTarget, [
        { label: `Save to “${view.name}”`, icon: 'check', onSelect: async () => { await updateView(view.id, { config: { ...saved, sort: cfg.sort || null, filters } }); st.draft = null; changed(); } },
        { label: 'Save as a new view', icon: 'plus', onSelect: () => newView(view.type, '', { ...saved, sort: cfg.sort || null, filters }) },
      ], { align: 'end' }) }, 'Save view', icon('chevron-down', 12)),
    ] : null,
    h('label', { class: 'tsearch' }, icon('search', 14), search),
    settingsBtn));
  if (st.openValue !== undefined) {
    const i = st.openValue; delete st.openValue;
    setTimeout(() => toolbar.querySelectorAll('.fchip')[i]?.querySelector('.val')?.click());
  }

  /* ---------------------------------------------------------------- content */
  const wrap = h('div', { style: { minHeight: '100%', position: 'relative' } });
  if (!all.length) {
    wrap.append(emptyState(def, object));
  } else if (!rows.length) {
    wrap.append(h('div', { class: 'empty' }, art('filter'), h('h2', null, 'No matches'),
      h('p', null, st.search ? `Nothing matches “${st.search}”${filters.length ? ' with these filters' : ''}.` : 'Nothing matches these filters.'),
      h('button', { class: 'btn', onClick: () => { st.search = ''; if (filters.length) setDraft({ filters: [] }); else changed(); } }, 'Clear search and filters')));
  } else if (view.type === 'board' && object === 'deals') {
    renderBoard(wrap, { rows, fields, config: cfg, onMove: (r, to, el) => moveDeal(r, to, el) });
  } else {
    renderTable(wrap, {
      object, rows, fields, config: cfg, selection: st.selection, limit: st.limit, focus: st.focus,
      onSelection: changed, onLayout: saveLayout, onCreate: () => newRecord(),
      onSort: (sort) => setDraft({ sort }), onFilterBy: (f) => addFilter(f),
      onMore: () => { st.limit += 200; changed(); },
    });
  }
  if (st.selection.size) wrap.append(bulkBar(object, st, fields));
  mount(content, wrap);

  /* keyboard for this page, called by the app's global handler */
  return {
    onKey(e) {
      if (e.key === '/') { e.preventDefault(); search.focus(); return true; }
      if (view.type === 'board') return false;
      const shown = rows.slice(0, st.limit);
      if (e.key === 'ArrowDown' || e.key === 'j') { st.focus = Math.min(shown.length - 1, st.focus + 1); changed(); scrollToFocus(); return true; }
      if (e.key === 'ArrowUp' || e.key === 'k') { st.focus = Math.max(0, st.focus - 1); changed(); scrollToFocus(); return true; }
      if (e.key === 'Enter' && shown[st.focus]) { nav.openRecord(object, shown[st.focus].id, rows.map((r) => r.id)); return true; }
      if (e.key === 'x' && shown[st.focus]) { const id = shown[st.focus].id; if (st.selection.has(id)) st.selection.delete(id); else st.selection.add(id); changed(); return true; }
      if (e.key === 'Escape' && st.selection.size) { st.selection.clear(); changed(); return true; }
      return false;
    },
  };
}

function scrollToFocus() {
  requestAnimationFrame(() => document.querySelector('.grid tr.focused')?.scrollIntoView({ block: 'nearest' }));
}

function moveDeal(r, to, el) {
  const s = stagesMap().get(to);
  if (s.kind === 'lost') {
    const reasons = setting('lost_reasons', []);
    let picked = false;
    listbox(el, {
      placeholder: 'Why was it lost?', width: 260,
      items: [{ group: `Mark “${r.name}” as lost` }, ...reasons.map((x) => ({ label: x, value: x })), { sep: true }, { label: 'No reason', value: null, icon: 'x' }],
      onPick: (it) => { picked = true; updateRecord('deals', r.id, { stage: to, lost_reason: it.value }, { undoLabel: `${r.name} marked lost` }).catch(() => {}); },
      create: (x) => { picked = true; updateRecord('deals', r.id, { stage: to, lost_reason: x }, { undoLabel: `${r.name} marked lost` }).catch(() => {}); },
      // Closing the picker without choosing puts the card back where it was.
      onClose: () => setTimeout(() => { if (!picked) changed(); }),
    });
    return;
  }
  updateRecord('deals', r.id, { stage: to }, { undoLabel: `Moved ${r.name} to ${s.name}` }).catch(() => {});
}

function bulkBar(object, st, fields) {
  const ids = [...st.selection];
  const editable = fields.filter((f) => !f.readonly && f.key !== OBJECTS[object].primary);
  return h('div', { class: 'bulkbar', role: 'toolbar', 'aria-label': 'Bulk actions' },
    h('b', { class: 'num' }, ids.length), h('span', { class: 'muted' }, 'selected'), h('span', { class: 'vsep' }),
    h('button', { class: 'btn sm', onClick: (e) => {
      const anchor = e.currentTarget;
      listbox(anchor, { placeholder: 'Edit which field?', items: editable.map((f) => ({ label: f.label, icon: typeIcon(f.type, f.to), onSelect: () => pickValue(anchor, f, null, (v) => {
        bulkUpdate(object, ids, { [f.key]: v }, `Updated ${f.label} on ${ids.length}`); st.selection.clear();
      }) })) });
    } }, icon('pencil', 13), 'Edit'),
    h('button', { class: 'btn sm danger', onClick: () => { bulkDelete(object, ids); st.selection.clear(); } }, icon('trash', 13), 'Delete'),
    h('button', { class: 'btn ghost icon sm', 'aria-label': 'Clear selection', onClick: () => { st.selection.clear(); changed(); } }, icon('x', 14)));
}

export function art(name) {
  return h('div', { class: 'art' }, h('div', { class: 'tile' }, icon(name, 22, 1.6)));
}

function emptyState(def, object) {
  const text = {
    people: 'Everyone you talk to: clients, leads, partners. Add one, or bring your list from HubSpot, Google Contacts or a spreadsheet.',
    companies: 'The businesses behind your people and deals. Add one, or import a CSV.',
    deals: 'Every opportunity, from first chat to won. Add a deal and drag it across the pipeline.',
  }[object];
  return h('div', { class: 'empty' }, art(def.icon), h('h2', null, `No ${def.plural.toLowerCase()} yet`), h('p', null, text),
    h('div', { class: 'row' }, h('button', { class: 'btn', onClick: () => openImport(object) }, icon('upload', 14), 'Import CSV'),
      h('button', { class: 'btn primary', onClick: () => nav.create(object) }, icon('plus', 14, 2.2), `New ${def.singular.toLowerCase()}`)));
}

export function nameDialog(title, value, onSave) {
  modal({
    title, width: 400,
    body: (b, m) => {
      const input = h('input', { class: 'input', value, placeholder: 'Name', 'aria-label': 'Name' });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); b.parentElement.querySelector('.btn.primary').click(); } });
      b.append(input);
      requestAnimationFrame(() => input.select());
    },
    footer: (f, m) => f.append(h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: m.close }, 'Cancel'),
      h('button', { class: 'btn primary', onClick: () => { const v = m.el.querySelector('input').value.trim(); if (v) { m.close(); onSave(v); } } }, 'Save')),
  });
}
