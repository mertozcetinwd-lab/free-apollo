/** How each field type looks when it is shown (not edited): table cells, record fields, cards. */

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { OBJECTS } from '../schema.js';
import { fmtMoney, fmtNumber, fmtDate, relTime, initials, hueFor, rawValue, dueBucket } from '../logic.js';
import { state, ctx, stagesMap } from '../store.js';
import { nav } from '../nav.js';

export function avatar(object, row, { size = 'sm' } = {}) {
  const name = row ? row[OBJECTS[object].primary] || '?' : '?';
  const square = object !== 'people';
  return h('span', { class: ['avatar', square && 'sq', size === 'lg' && 'lg'], 'data-c': hueFor(name), 'aria-hidden': 'true' },
    object === 'deals' ? icon('target', size === 'lg' ? 20 : 12, 2) : initials(name));
}

export function stagePill(key) {
  const s = stagesMap().get(key);
  if (!s) return h('span', { class: 'pill' }, key || 'No stage');
  return h('span', { class: 'pill', 'data-c': s.color }, h('span', { class: 'dot' }), s.name);
}

export function recordChip(object, id, { plain = false } = {}) {
  const row = state.byId[object]?.get(Number(id));
  if (!row) return h('span', { class: 'faint' }, id ? 'Deleted record' : '');
  return h('span', {
    class: 'chipref', title: row[OBJECTS[object].primary],
    onClick: plain ? null : (e) => { e.stopPropagation(); nav.openRecord(object, row.id); },
  }, avatar(object, row), h('span', { class: 'ellipsis' }, row[OBJECTS[object].primary] || 'Untitled'));
}

export function tagPills(text) {
  return h('span', { class: 'row', style: { gap: '4px', flexWrap: 'nowrap', overflow: 'hidden' } },
    String(text).split(',').map((t) => t.trim()).filter(Boolean).map((t) => h('span', { class: 'pill', 'data-c': hueFor(t) }, t)));
}

/** A value as a node. `where` is 'cell', 'field' or 'card' (links are only clickable outside cells). */
export function valueNode(row, field, where = 'cell') {
  const v = rawValue(row, field);
  const c = ctx();
  if (v === null || v === undefined || v === '' || (field.type === 'checkbox' && v === false && where !== 'cell')) {
    if (field.type === 'checkbox' && where === 'cell') return checkNode(false);
    return where === 'field' ? h('span', { class: 'ph' }, field.readonly ? 'Unknown' : 'Empty') : h('span', { class: 'empty-cell' }, '');
  }
  switch (field.type) {
    case 'currency': return h('span', { class: 'num' }, fmtMoney(v, c.currency));
    case 'number': return h('span', { class: 'num' }, fmtNumber(v));
    case 'date': {
      const bucket = field.key === 'due_date' ? dueBucket(v, c.today) : null;
      return h('span', { style: bucket === 'overdue' ? { color: 'var(--red)' } : null }, fmtDate(v, c.dateFormat));
    }
    case 'timestamp': return h('span', { title: new Date(v).toLocaleString() }, relTime(v));
    case 'checkbox': return checkNode(!!v);
    case 'stage': return stagePill(v);
    case 'select': {
      const o = (field.options || []).find((x) => x.value === v);
      return h('span', { class: 'pill', 'data-c': o?.color || 'gray' }, v);
    }
    case 'tags': return tagPills(v);
    case 'relation': return recordChip(field.to, v);
    case 'email': return where === 'field' ? h('a', { href: 'mailto:' + v, onClick: (e) => e.stopPropagation() }, v) : h('span', null, v);
    case 'phone': return where === 'field' ? h('a', { href: 'tel:' + String(v).replace(/[^+\d]/g, ''), onClick: (e) => e.stopPropagation() }, v) : h('span', null, v);
    case 'url': case 'domain': {
      const href = field.type === 'domain' ? 'https://' + v : v;
      const text = String(v).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
      return where === 'cell' ? h('span', null, text) : h('a', { href, target: '_blank', rel: 'noopener noreferrer', onClick: (e) => e.stopPropagation() }, text);
    }
    default: return h('span', null, String(v));
  }
}

function checkNode(on) {
  return h('span', { class: 'check', 'aria-checked': on ? 'true' : 'false', role: 'img', 'aria-label': on ? 'Yes' : 'No' }, on ? icon('check', 12, 2.5) : null);
}
