/** Turns activity rows into sentences: "Stage: Lead → Proposal", "Added a task “Send quote”". */

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { OBJECTS } from '../schema.js';
import { fmtMoney, fmtDate, relTime } from '../logic.js';
import { state, ctx, fields } from '../store.js';
import { nav } from '../nav.js';
import { stagePill } from './values.js';

const ICON = { created: 'plus', updated: 'pencil', stage: 'board', deleted: 'trash', restored: 'arrow-up', note: 'file-text', task: 'check-square', task_done: 'check-circle' };

function fmt(field, v) {
  const c = ctx();
  if (v === null || v === undefined || v === '') return h('span', { class: 'faint' }, 'empty');
  if (!field) return h('b', null, String(v));
  switch (field.type) {
    case 'currency': return h('b', { class: 'num' }, fmtMoney(v, c.currency));
    case 'date': return h('b', null, fmtDate(v, c.dateFormat));
    case 'relation': return h('b', null, state.byId[field.to]?.get(Number(v))?.name || 'a deleted record');
    case 'stage': return stagePill(v);
    case 'checkbox': return h('b', null, v ? 'Yes' : 'No');
    default: return h('b', { class: 'ellipsis', style: { maxWidth: '240px', display: 'inline-block', verticalAlign: 'bottom' } }, String(v));
  }
}

/** One activity row. `self` is the record whose timeline this is, so its own name is not repeated. */
export function activityItem(a, self) {
  const def = OBJECTS[a.record_type];
  const f = a.data.field ? fields(a.record_type).find((x) => x.key === a.data.field) : null;
  const foreign = !self || self.object !== a.record_type || self.id !== a.record_id;
  const alive = state.byId[a.record_type]?.has(a.record_id);
  const who = foreign ? h('b', {
    style: alive ? { cursor: 'pointer' } : null,
    onClick: alive ? () => nav.openRecord(a.record_type, a.record_id) : null,
  }, a.label || def?.singular) : null;
  const pre = who ? [who, ' · '] : [];
  let text;
  switch (a.kind) {
    case 'created': text = [...pre, foreign ? 'Created' : `Created this ${def.singular.toLowerCase()}`, a.data.via === 'import' ? ' by import' : '']; break;
    case 'updated': text = a.data.from === undefined && a.data.to === undefined
      ? [...pre, 'Edited ', h('b', null, f ? f.label.toLowerCase() : a.data.field)]
      : [...pre, f ? f.label : a.data.field, ': ', fmt(f, a.data.from), h('span', { class: 'arrow' }, '→'), fmt(f, a.data.to)]; break;
    case 'stage': text = [...pre, 'Moved ', stagePill(a.data.from), h('span', { class: 'arrow' }, '→'), stagePill(a.data.to)]; break;
    case 'deleted': text = [...pre, 'Deleted']; break;
    case 'restored': text = [...pre, 'Restored']; break;
    case 'note': text = [...pre, 'Added a note ', h('b', null, `“${a.data.title || 'Untitled'}”`)]; break;
    case 'task': text = [...pre, 'Added a task ', h('b', null, `“${a.data.title}”`)]; break;
    case 'task_done': text = [...pre, a.data.done ? 'Completed ' : 'Reopened ', h('b', null, `“${a.data.title}”`)]; break;
    default: text = [...pre, a.kind];
  }
  return h('div', { class: 'tl' },
    h('span', { class: 'ic' }, icon(ICON[a.kind] || 'activity', 13)),
    h('div', { class: 'tx' }, text),
    h('span', { class: 'when', title: new Date(a.created_at).toLocaleString() }, relTime(a.created_at)));
}
