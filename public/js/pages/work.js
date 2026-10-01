/** The Tasks page (grouped by when they are due) and the Notes page (cards grouped by date). */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { dueBucket, todayISO, addDays, localDate } from '../logic.js';
import { state, changed } from '../store.js';
import { taskComposer, taskRow, sortTasks, noteCard, openNote } from '../ui/work.js';
import { art } from './list.js';

const tv = { showDone: false, filter: 'open' };

const menuBtn = () => h('button', { class: 'btn ghost icon menu-btn', 'aria-label': 'Menu', onClick: () => document.querySelector('.app').classList.toggle('side-open') }, icon('sidebar', 16));

export function renderTasks({ top, toolbar, content }) {
  toolbar.hidden = true;
  const today = todayISO();
  const all = sortTasks(state.rows.tasks || []);
  const open = all.filter((t) => !t.done_at);
  const done = all.filter((t) => t.done_at).sort((a, b) => b.done_at.localeCompare(a.done_at));
  const weekEnd = addDays(today, 7);
  const groups = [
    ['Overdue', open.filter((t) => dueBucket(t.due_date, today) === 'overdue'), 'red'],
    ['Today', open.filter((t) => t.due_date === today)],
    ['Next 7 days', open.filter((t) => t.due_date > today && t.due_date <= weekEnd)],
    ['Later', open.filter((t) => t.due_date > weekEnd)],
    ['No date', open.filter((t) => !t.due_date)],
  ];
  mount(top, menuBtn(), h('div', { class: 'title' }, icon('check-square', 15), 'Tasks', h('span', { class: 'count num' }, open.length)));
  mount(content, h('div', { class: 'page-pad', style: { maxWidth: '820px' } },
    taskComposer({ autofocus: false }),
    !all.length ? h('div', { class: 'empty' }, art('check-square'), h('h2', null, 'No tasks yet'),
      h('p', null, 'Type a task above and press Enter. Add @ to link it to a person, company or deal; a deal with a task counts as having a next step.')) : null,
    groups.map(([label, list, tone]) => list.length ? [
      h('div', { class: ['group-h', tone === 'red' && 'red'] }, label, h('span', { class: 'n num' }, list.length)),
      list.map((t) => taskRow(t)),
    ] : null),
    done.length ? [
      h('button', { class: 'btn ghost sm', style: { marginTop: '18px' }, onClick: () => { tv.showDone = !tv.showDone; changed(); } },
        icon(tv.showDone ? 'chevron-down' : 'chevron-right', 13), `Completed · ${done.length}`),
      tv.showDone ? done.slice(0, 100).map((t) => taskRow(t)) : null,
    ] : null));
}

export function renderNotes({ top, toolbar, content }) {
  toolbar.hidden = true;
  const notes = [...(state.rows.notes || [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const today = todayISO(); const weekAgo = addDays(today, -7);
  const groups = [
    ['Today', notes.filter((n) => localDate(n.updated_at) === today)],
    ['This week', notes.filter((n) => localDate(n.updated_at) < today && localDate(n.updated_at) > weekAgo)],
    ['Earlier', notes.filter((n) => localDate(n.updated_at) <= weekAgo)],
  ];
  mount(top, menuBtn(), h('div', { class: 'title' }, icon('file-text', 15), 'Notes', h('span', { class: 'count num' }, notes.length)),
    h('span', { class: 'grow' }), h('button', { class: 'btn primary', onClick: () => openNote(null) }, icon('plus', 14, 2.2), 'New note', h('kbd', null, 'N')));
  mount(content, h('div', { class: 'page-pad' },
    !notes.length ? h('div', { class: 'empty' }, art('file-text'), h('h2', null, 'No notes yet'),
      h('p', null, 'Meeting notes, call recaps, what they said about budget. Link each note to a person, company or deal so it shows on their timeline.'),
      h('button', { class: 'btn primary', onClick: () => openNote(null) }, icon('plus', 14, 2.2), 'New note')) : null,
    groups.map(([label, list]) => list.length ? [
      h('div', { class: 'group-h' }, label, h('span', { class: 'n num' }, list.length)),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '12px' } }, list.map((n) => noteCard(n))),
    ] : null)));
}
