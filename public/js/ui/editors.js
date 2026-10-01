/**
 * Inline editing. Click a value, change it where it is, press Enter (or click away) to save,
 * Escape to cancel. Every value goes through the same cleanValue() the server uses, so a bad
 * value is caught in place.
 */

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { OBJECTS, cleanValue } from '../schema.js';
import { rawValue, todayISO, addDays, fmtDate } from '../logic.js';
import { state, updateRecord, createRecord, ctx } from '../store.js';
import { listbox, popover, closePopover } from './overlay.js';
import { avatar } from './values.js';

/** Save one field. Stage moves get an Undo toast; everything else saves quietly. */
export function saveField(object, row, field, value) {
  if (String(value ?? '') === String(rawValue(row, field) ?? '')) return;
  const opts = {};
  if (field.type === 'stage') {
    const s = ctx().stages.get(value);
    opts.undoLabel = `Moved to ${s ? s.name : value}`;
  }
  return updateRecord(object, row.id, { [field.key]: value }, opts).catch(() => {});
}

export function editField(anchor, object, row, field, { onDone } = {}) {
  if (field.readonly) return;
  const done = () => onDone?.();
  switch (field.type) {
    case 'checkbox': saveField(object, row, field, !rawValue(row, field)); return done();
    case 'stage': return pickStage(anchor, rawValue(row, field), (key) => { saveField(object, row, field, key); done(); });
    case 'select': return pickOption(anchor, field, rawValue(row, field), (v) => { saveField(object, row, field, v); done(); });
    case 'relation': return pickRecord(anchor, field.to, rawValue(row, field), (id) => { saveField(object, row, field, id); done(); }, { allowClear: true });
    case 'date': return pickDate(anchor, rawValue(row, field), (d) => { saveField(object, row, field, d); done(); });
    default: return textEditor(anchor, object, row, field, done);
  }
}

function textEditor(anchor, object, row, field, done) {
  closePopover();
  const r = anchor.getBoundingClientRect();
  let v = rawValue(row, field);
  if (field.type === 'currency' && v !== null) v = (Number(v) / 100).toString();
  const multi = field.type === 'longtext';
  const input = h(multi ? 'textarea' : 'input', {
    value: v ?? '', 'aria-label': field.label,
    inputmode: ['number', 'currency'].includes(field.type) ? 'decimal' : null,
    placeholder: field.type === 'tags' ? 'comma, separated, tags' : field.type === 'currency' ? '0.00' : field.label,
  });
  const err = h('div', { class: 'err', hidden: true });
  const box = h('div', { class: 'cell-editor' }, input, err);
  Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: Math.max(r.width, 240) + 'px' });
  document.body.append(box);
  // Keep the editor on screen when the cell is near the right or bottom edge.
  const bw = box.offsetWidth;
  if (r.left + bw > window.innerWidth - 8) box.style.left = Math.max(8, window.innerWidth - bw - 8) + 'px';
  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    let value = input.value;
    if (commit) {
      if (field.type === 'currency' && value.trim() !== '') {
        const n = Number(value.replace(/[^0-9.\-]/g, ''));
        value = Number.isFinite(n) ? Math.round(n * 100) : 'x';
      }
      const c = cleanValue(field, value);
      if (!c.ok) { err.textContent = c.error; err.hidden = false; input.focus(); return; }
      finished = true; box.remove(); document.removeEventListener('pointerdown', outside, true);
      saveField(object, row, field, c.value);
    } else {
      finished = true; box.remove(); document.removeEventListener('pointerdown', outside, true);
    }
    done();
  };
  const outside = (e) => { if (!box.contains(e.target)) finish(true); };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Enter' && (!multi || e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
    else if (e.key === 'Tab') { finish(true); }
  });
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  input.focus();
  if (input.select) input.select();
}

export function pickStage(anchor, current, onPick) {
  const items = state.meta.stages.map((s) => ({
    label: s.name, value: s.key, checked: s.key === current,
    lead: h('span', { class: 'dot', 'data-c': s.color }),
    hint: s.kind === 'open' ? '' : s.kind === 'won' ? 'Won' : 'Lost',
  }));
  return listbox(anchor, { items, placeholder: 'Move to stage…', onPick: (it) => onPick(it.value) });
}

function pickOption(anchor, field, current, onPick) {
  const items = [
    ...(field.options || []).map((o) => ({ label: o.value, value: o.value, checked: o.value === current, lead: h('span', { class: 'dot', 'data-c': o.color }) })),
    ...(current ? [{ sep: true }, { label: 'Clear', icon: 'x', value: null }] : []),
  ];
  return listbox(anchor, { items, placeholder: field.label + '…', onPick: (it) => onPick(it.value) });
}

/** Search people, companies or deals; optionally create a new one from what was typed. */
export function pickRecord(anchor, object, current, onPick, { allowClear = false, placeholder } = {}) {
  const def = OBJECTS[object];
  const rows = [...(state.rows[object] || [])].sort((a, b) => String(a[def.primary]).localeCompare(String(b[def.primary])));
  const items = rows.map((r) => ({
    label: r[def.primary] || 'Untitled', value: r.id, checked: r.id === current, lead: avatar(object, r),
    sub: object === 'people' ? (r.email || '') : object === 'companies' ? (r.domain || '') : '',
  }));
  if (allowClear && current) items.unshift({ label: 'Remove', icon: 'x', value: null }, { sep: true });
  return listbox(anchor, {
    items, placeholder: placeholder || `Find a ${def.singular.toLowerCase()}…`, width: 340,
    onPick: (it) => onPick(it.value),
    create: object === 'tasks' || object === 'notes' ? null : async (name) => {
      const row = await createRecord(object, { name });
      onPick(row.id);
    },
  });
}

/**
 * Pick a value for a field without a row (filters and bulk edit). Calls onPick(value), where a
 * currency value is in cents when `cents` is true and in dollars otherwise (filters use dollars).
 */
export function pickValue(anchor, field, current, onPick, { cents = true } = {}) {
  switch (field.type) {
    case 'stage': return pickStage(anchor, current, onPick);
    case 'select': return pickOption(anchor, field, current, onPick);
    case 'relation': return pickRecord(anchor, field.to, current ? Number(current) : null, onPick);
    case 'date': case 'timestamp': return pickDate(anchor, current, onPick);
    case 'checkbox': return listbox(anchor, { search: false, items: [{ label: 'Yes', value: true }, { label: 'No', value: false }], onPick: (it) => onPick(it.value) });
    default:
      return popover(anchor, (el, pop) => {
        const input = h('input', { class: 'input', value: current ?? '', placeholder: field.type === 'currency' ? 'Amount in dollars' : field.label, inputmode: ['number', 'currency'].includes(field.type) ? 'decimal' : null });
        const err = h('div', { class: 'field-error', hidden: true });
        const apply = () => {
          let v = input.value.trim();
          if (field.type === 'currency' && v !== '' && cents) v = Math.round(Number(v.replace(/[^0-9.\-]/g, '')) * 100);
          if (cents) {
            const c = cleanValue(field, v);
            if (!c.ok) { err.textContent = c.error; err.hidden = false; return; }
            v = c.value;
          }
          pop.close(); onPick(v);
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
        el.append(h('div', { class: 'pop-body' }, input, err, h('button', { class: 'btn primary sm', onClick: apply }, 'Apply')));
        input.focus();
      }, { width: 260 });
  }
}

export function pickDate(anchor, current, onPick) {
  const today = todayISO();
  return popover(anchor, (el, pop) => {
    const input = h('input', { type: 'date', class: 'input', value: current || '', 'aria-label': 'Date' });
    const quick = [['Today', today], ['Tomorrow', addDays(today, 1)], ['In 3 days', addDays(today, 3)], ['Next week', addDays(today, 7)]];
    const choose = (d) => { pop.close(); onPick(d); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); choose(input.value || null); } });
    input.addEventListener('change', () => { if (input.value) choose(input.value); });
    el.append(h('div', { class: 'pop-body' }, input));
    el.append(...quick.map(([label, d]) => h('button', { class: 'pop-item', type: 'button', onClick: () => choose(d) },
      h('span', { class: 'ic' }, icon('calendar', 15)), label, h('span', { class: 'hint' }, fmtDate(d, ctx().dateFormat)))));
    if (current) el.append(h('div', { class: 'pop-sep' }), h('button', { class: 'pop-item', type: 'button', onClick: () => choose(null) }, h('span', { class: 'ic' }, icon('x', 15)), 'Clear date'));
    input.focus();
  }, { width: 240 });
}
