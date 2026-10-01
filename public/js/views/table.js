/**
 * The table view: sticky name column, typed headers, click-to-edit cells, resizable columns,
 * footer calculations, row selection, and ↑ ↓ Enter x on the keyboard.
 */

import { h } from '../dom.js';
import { icon, typeIcon } from '../icons.js';
import { OBJECTS } from '../schema.js';
import { calc, calcsFor, CALCS, fmtMoney, fmtNumber } from '../logic.js';
import { ctx } from '../store.js';
import { nav } from '../nav.js';
import { menu, listbox } from '../ui/overlay.js';
import { valueNode, avatar } from '../ui/values.js';
import { editField } from '../ui/editors.js';

const WIDTH = { currency: 130, number: 110, date: 130, timestamp: 130, stage: 150, relation: 190, email: 220, tags: 190, checkbox: 90, url: 190, domain: 170, phone: 150 };
export const widthFor = (f, widths = {}) => widths[f.key] || (f.key === 'name' || f.key === 'title' ? 260 : WIDTH[f.type] || 170);

export function defaultColumns(object, fields) {
  const primary = OBJECTS[object].primary;
  return [primary, ...fields.filter((f) => f.key !== primary && !f.readonly).slice(0, 5).map((f) => f.key)];
}

export function renderTable(root, o) {
  const { object, rows, fields, config, selection, limit } = o;
  const primary = OBJECTS[object].primary;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  let keys = (config.columns && config.columns.length ? config.columns : defaultColumns(object, fields)).filter((k) => byKey.has(k));
  keys = [primary, ...keys.filter((k) => k !== primary)];
  const cols = keys.map((k) => byKey.get(k));
  const widths = { ...(config.widths || {}) };
  const shown = rows.slice(0, limit);
  const c = ctx();

  const colgroup = h('colgroup', null, h('col', { style: { width: '36px' } }),
    cols.map((f) => h('col', { 'data-k': f.key, style: { width: widthFor(f, widths) + 'px' } })), h('col'));  // last col absorbs spare width

  /* ---------- header */
  const allOn = shown.length > 0 && shown.every((r) => selection.has(r.id));
  const headCheck = h('button', {
    class: 'check', role: 'checkbox', 'aria-checked': allOn ? 'true' : 'false', 'aria-label': 'Select all',
    onClick: () => { if (allOn) shown.forEach((r) => selection.delete(r.id)); else shown.forEach((r) => selection.add(r.id)); o.onSelection(); },
  }, allOn ? icon('check', 12, 2.5) : null);

  const headerCell = (f, i) => {
    const sorted = config.sort && config.sort.field === f.key ? config.sort.dir : null;
    const th = h('th', { class: [f.key === primary && 'c-primary', ['currency', 'number'].includes(f.type) && 'num'], scope: 'col' },
      h('div', {
        class: 'th', role: 'button', tabIndex: 0,
        onClick: (e) => columnMenu(e.currentTarget, f, i),
        onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); columnMenu(e.currentTarget, f, i); } },
      }, icon(typeIcon(f.type, f.to), 14), h('span', { class: 'ellipsis' }, f.label),
      sorted ? h('span', { class: 'sort-ind' }, icon(sorted === 'asc' ? 'arrow-up' : 'arrow-down', 12, 2)) : null),
      h('span', { class: 'resize', onPointerdown: (e) => startResize(e, f) }));
    return th;
  };

  const columnMenu = (anchor, f, i) => {
    const items = [
      { label: 'Sort ascending', icon: 'arrow-up', onSelect: () => o.onSort({ field: f.key, dir: 'asc' }) },
      { label: 'Sort descending', icon: 'arrow-down', onSelect: () => o.onSort({ field: f.key, dir: 'desc' }) },
      { label: 'Filter by this', icon: 'filter', onSelect: () => o.onFilterBy(f) },
    ];
    if (f.key !== primary) {
      items.push({ sep: true });
      if (i > 1) items.push({ label: 'Move left', icon: 'arrow-left', onSelect: () => moveCol(f.key, -1) });
      if (i < keys.length - 1) items.push({ label: 'Move right', icon: 'arrow-right', onSelect: () => moveCol(f.key, 1) });
      items.push({ label: 'Hide column', icon: 'eye-off', onSelect: () => o.onLayout({ columns: keys.filter((k) => k !== f.key) }) });
    }
    menu(anchor, items);
  };
  const moveCol = (k, d) => {
    const next = [...keys]; const i = next.indexOf(k); const j = i + d;
    if (j < 1 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    o.onLayout({ columns: next });
  };
  const addColumn = (anchor) => {
    const hidden = fields.filter((f) => !keys.includes(f.key));
    listbox(anchor, {
      placeholder: 'Add a column…', empty: 'Every field is showing',
      items: hidden.map((f) => ({ label: f.label, value: f.key, icon: typeIcon(f.type, f.to), hint: f.custom ? 'Custom' : '' })),
      onPick: (it) => o.onLayout({ columns: [...keys, it.value] }),
      align: 'end',
    });
  };
  const startResize = (e, f) => {
    e.preventDefault(); e.stopPropagation();
    const handle = e.currentTarget; handle.classList.add('on');
    const col = colgroup.querySelector(`col[data-k="${f.key}"]`);
    const start = e.clientX; const w0 = widthFor(f, widths);
    const move = (ev) => { widths[f.key] = Math.max(80, Math.min(600, w0 + ev.clientX - start)); col.style.width = widths[f.key] + 'px'; };
    const up = () => {
      handle.classList.remove('on');
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (widths[f.key] !== w0) o.onLayout({ widths });
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const thead = h('thead', null, h('tr', null,
    h('th', { class: 'c-check' }, headCheck),
    cols.map(headerCell),
    h('th', { class: 'c-add' }, h('button', { 'aria-label': 'Add column', title: 'Add column', onClick: (e) => addColumn(e.currentTarget) }, icon('plus', 15)))));

  /* ---------- body */
  const openRow = (r) => nav.openRecord(object, r.id, rows.map((x) => x.id));
  const tbody = h('tbody', null, shown.map((r, idx) => {
    const on = selection.has(r.id);
    return h('tr', { class: [on && 'selected', idx === o.focus && 'focused'], 'data-id': r.id },
      h('td', { class: 'c-check' }, h('button', {
        class: 'check', role: 'checkbox', 'aria-checked': on ? 'true' : 'false', 'aria-label': 'Select row',
        onClick: () => { if (on) selection.delete(r.id); else selection.add(r.id); o.onSelection(); },
      }, on ? icon('check', 12, 2.5) : null)),
      cols.map((f) => {
        if (f.key === primary) {
          return h('td', { class: 'c-primary' }, h('div', { class: 'prim' }, avatar(object, r),
            h('span', { class: 'name', role: 'link', tabIndex: -1, onClick: () => openRow(r) }, r[primary] || 'Untitled')));
        }
        const editable = !f.readonly;
        return h('td', {
          class: [editable && 'editable', ['currency', 'number'].includes(f.type) && 'num'],
          onClick: editable ? (e) => editField(e.currentTarget, object, r, f) : null,
        }, valueNode(r, f, 'cell'));
      }),
      h('td'));
  }));
  tbody.append(h('tr', { class: 'addrow', onClick: () => o.onCreate() },
    h('td', { class: 'c-check' }, icon('plus', 14)), h('td', { colSpan: cols.length + 1 }, `New ${OBJECTS[object].singular.toLowerCase()}`)));

  /* ---------- footer */
  const calcs = config.calcs || {};
  const fmt = (f, v) => (v === null || v === undefined ? 'Unknown' : f.type === 'currency' && !['count', 'filled', 'empty', 'percent_filled'].includes(calcs[f.key]) ? fmtMoney(v, c.currency) : calcs[f.key] === 'percent_filled' ? v + '%' : fmtNumber(v));
  const tfoot = h('tfoot', null, h('tr', null,
    h('td', { class: 'c-check' }),
    cols.map((f) => {
      if (f.key === primary) return h('td', { class: 'c-primary' }, h('span', null, h('b', { class: 'num' }, rows.length), ' ', rows.length === 1 ? 'record' : 'records'));
      const fn = calcs[f.key];
      return h('td', { class: 'num' }, h('div', {
        class: ['calc', fn && 'set'], role: 'button', tabIndex: 0,
        onClick: (e) => listbox(e.currentTarget, {
          search: false, width: 200,
          items: [...calcsFor(f.type).map((k) => ({ label: CALCS[k], value: k, checked: fn === k })), ...(fn ? [{ sep: true }, { label: 'None', value: null }] : [])],
          onPick: (it) => { const next = { ...calcs }; if (it.value) next[f.key] = it.value; else delete next[f.key]; o.onLayout({ calcs: next }); },
        }),
      }, fn ? [h('span', null, CALCS[fn]), h('b', { class: 'num' }, fmt(f, calc(rows, f, fn)))] : ['Calculate', icon('chevron-down', 12)]));
    }),
    h('td')));

  const table = h('table', { class: 'grid', role: 'grid', 'aria-rowcount': rows.length }, colgroup, thead, tbody, tfoot);
  table.style.width = 36 + 60 + cols.reduce((a, f) => a + widthFor(f, widths), 0) + 'px';
  root.append(table);
  if (rows.length > limit) {
    root.append(h('div', { class: 'more-rows' }, h('button', { class: 'btn', onClick: o.onMore }, `Show ${Math.min(200, rows.length - limit)} more of ${rows.length - limit}`)));
  }
  return { openRow, shown };
}
