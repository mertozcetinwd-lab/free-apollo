/**
 * Tasks and notes: the quick composers and the rows/cards, shared by the record view, the Tasks
 * page and the Notes page. Typing "@" in the task composer links a record.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { OBJECTS, RECORD_OBJECTS } from '../schema.js';
import { fmtDate, dueBucket, todayISO, relTime } from '../logic.js';
import { state, ctx, createRecord, updateRecord, deleteRecord, recordName } from '../store.js';
import { listbox, menu, modal, toast } from './overlay.js';
import { pickDate } from './editors.js';
import { recordChip, avatar } from './values.js';

/* ---------------------------------------------------------------- tasks */

/**
 * The composer survives re-renders (same element, same half-typed text): the page re-renders after
 * every save, and a quick run of tasks should never lose focus or what you were typing.
 */
const composers = new Map();

export function taskComposer({ link = null, placeholder = 'Add a task… type @ to link a record', autofocus = false, cache = true } = {}) {
  const key = (link ? `${link.type}-${link.id}` : 'free') + (cache ? '' : '-once');
  const cached = cache && composers.get(key);
  if (cached) { if (autofocus) requestAnimationFrame(() => cached.querySelector('input').focus()); return cached; }
  let due = null; let linked = link;
  const input = h('input', { placeholder, 'aria-label': 'New task', id: 'task-composer-' + key, autocomplete: 'off' });
  const dueBtn = h('button', { class: 'btn ghost sm', type: 'button' });
  const linkWrap = h('span', { class: 'row', style: { gap: '4px', minWidth: 0 } });
  const renderBar = () => {
    mount(dueBtn, icon('calendar', 13), due ? fmtDate(due, ctx().dateFormat) : 'Due date');
    mount(linkWrap, linked ? [recordChip(linked.type, linked.id, { plain: true }),
      link ? null : h('button', { class: 'btn ghost icon sm', 'aria-label': 'Unlink', type: 'button', onClick: () => { linked = null; renderBar(); } }, icon('x', 12))] : null);
  };
  dueBtn.addEventListener('click', () => pickDate(dueBtn, due, (d) => { due = d; renderBar(); input.focus(); }));
  const mentionPicker = (query) => {
    const items = RECORD_OBJECTS.flatMap((o) => (state.rows[o] || []).map((r) => ({
      label: r[OBJECTS[o].primary], sub: OBJECTS[o].singular, lead: avatar(o, r), onSelect: () => {
        linked = { type: o, id: r.id };
        input.value = input.value.replace(/@([^@]*)$/, '').trimEnd() + ' ';
        renderBar(); input.focus();
      },
    })));
    listbox(input, { items, placeholder: 'Link to…', width: 300 });
    const s = document.querySelector('.pop-search input');
    if (s) { s.value = query; s.dispatchEvent(new Event('input')); }
  };
  input.addEventListener('input', () => { const m = input.value.match(/@([^@\s]*)$/); if (m && !link) mentionPicker(m[1]); });
  const submit = async () => {
    const title = input.value.replace(/\s+/g, ' ').trim();
    if (!title) return;
    input.value = '';
    await createRecord('tasks', { title, due_date: due, record_type: linked?.type || null, record_id: linked?.id || null }).catch(() => { input.value = title; });
    due = null; if (!link) linked = null; renderBar();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  renderBar();
  if (autofocus) requestAnimationFrame(() => input.focus());
  const el = h('div', { class: 'composer' }, input,
    h('div', { class: 'bar' }, dueBtn, linkWrap, h('span', { class: 'grow' }),
      h('span', { class: 'faint', style: { fontSize: 'var(--fs-sm)' } }, 'Enter to add')));
  if (composers.size > 50) composers.clear();
  if (cache) composers.set(key, el);
  return el;
}

export function taskRow(t, { showLink = true } = {}) {
  const c = ctx();
  const done = !!t.done_at;
  const bucket = done ? null : dueBucket(t.due_date, c.today);
  const title = h('span', { class: 'tt ellipsis', tabIndex: 0, role: 'button', title: 'Rename' }, t.title);
  title.addEventListener('click', () => renameTask(t));
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') renameTask(t); });
  return h('div', { class: ['task', done && 'done'] },
    h('button', {
      class: 'check round', role: 'checkbox', 'aria-checked': done ? 'true' : 'false', 'aria-label': done ? 'Mark not done' : 'Mark done',
      onClick: () => updateRecord('tasks', t.id, { done: !done }, done ? {} : { undoLabel: 'Task completed' }).catch(() => {}),
    }, done ? icon('check', 11, 3) : null),
    title,
    showLink && t.record_type ? recordChip(t.record_type, t.record_id) : null,
    h('button', {
      class: ['due', 'btn ghost sm', bucket], title: 'Due date',
      onClick: (e) => pickDate(e.currentTarget, t.due_date, (d) => updateRecord('tasks', t.id, { due_date: d }).catch(() => {})),
    }, t.due_date ? (bucket === 'today' ? 'Today' : fmtDate(t.due_date, c.dateFormat)) : h('span', { class: 'hover-only' }, icon('calendar', 13))),
    h('button', { class: 'btn ghost icon sm hover-only', 'aria-label': 'Task actions', onClick: (e) => menu(e.currentTarget, [
      { label: 'Rename', icon: 'pencil', onSelect: () => renameTask(t) },
      { label: 'Delete task', icon: 'trash', danger: true, onSelect: () => deleteRecord('tasks', t.id) },
    ], { align: 'end' }) }, icon('more', 15)));
}

function renameTask(t) {
  modal({
    title: 'Edit task', width: 460,
    body: (b) => b.append(h('input', { class: 'input', value: t.title, 'aria-label': 'Task' })),
    footer: (f, m) => {
      const save = () => { const v = m.el.querySelector('input').value.trim(); if (v) { m.close(); updateRecord('tasks', t.id, { title: v }).catch(() => {}); } };
      m.el.querySelector('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      f.append(h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: m.close }, 'Cancel'), h('button', { class: 'btn primary', onClick: save }, 'Save'));
    },
  });
}

export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => (!!a.done_at - !!b.done_at) || String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')) || b.id - a.id);
}

/* ---------------------------------------------------------------- notes */

export function noteCard(n, { showLink = true } = {}) {
  return h('article', { class: 'note-card', tabIndex: 0, onClick: () => openNote(n), onKeydown: (e) => { if (e.key === 'Enter') openNote(n); } },
    n.title ? h('b', null, n.title) : null,
    n.body ? h('div', { class: 'body' }, n.body) : h('div', { class: 'faint' }, 'Empty note'),
    h('div', { class: 'foot' }, showLink && n.record_type ? recordChip(n.record_type, n.record_id) : null,
      h('span', { class: 'grow' }), h('span', { title: new Date(n.updated_at).toLocaleString() }, relTime(n.updated_at))));
}

/** The note editor: a title, a link to a record, and the body. Saves on close. */
export function openNote(note, { link } = {}) {
  let linked = note ? (note.record_type ? { type: note.record_type, id: note.record_id } : null) : link || null;
  modal({
    title: note ? 'Note' : 'New note', width: 640,
    body: (b) => {
      const title = h('input', { class: 'input', value: note?.title || '', placeholder: 'Title', 'aria-label': 'Title', style: { fontWeight: '600' } });
      const body = h('textarea', { class: 'textarea', placeholder: 'Write…', 'aria-label': 'Note', style: { minHeight: '220px' } });
      body.value = note?.body || '';
      const linkBtn = h('button', { class: 'btn sm', type: 'button' });
      const renderLink = () => mount(linkBtn, icon('link', 13), linked ? recordName(linked.type, linked.id) || 'Deleted record' : 'Link to a record');
      linkBtn.addEventListener('click', () => {
        const items = RECORD_OBJECTS.flatMap((o) => (state.rows[o] || []).map((r) => ({ label: r[OBJECTS[o].primary], sub: OBJECTS[o].singular, lead: avatar(o, r), onSelect: () => { linked = { type: o, id: r.id }; renderLink(); } })));
        listbox(linkBtn, { items: linked ? [{ label: 'Remove link', icon: 'x', onSelect: () => { linked = null; renderLink(); } }, { sep: true }, ...items] : items, width: 300, placeholder: 'Link to…' });
      });
      renderLink();
      b.append(title, h('div', { class: 'row' }, linkBtn), body);
      body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) b.closest('.modal').querySelector('.btn.primary').click(); });
    },
    footer: (f, m) => {
      const save = async () => {
        const title = m.el.querySelector('input').value.trim();
        const body = m.el.querySelector('textarea').value;
        const data = { title: title || null, body, record_type: linked?.type || null, record_id: linked?.id || null };
        m.close();
        if (!note) { if (title || body.trim()) await createRecord('notes', data).catch(() => {}); }
        else if (title !== (note.title || '') || body !== (note.body || '') || data.record_type !== note.record_type || data.record_id !== note.record_id) {
          await updateRecord('notes', note.id, data).catch(() => {});
        }
      };
      f.append(
        note ? h('button', { class: 'btn ghost danger', onClick: () => { m.close(); deleteRecord('notes', note.id); } }, icon('trash', 14), 'Delete') : null,
        h('span', { class: 'grow' }), h('span', { class: 'faint', style: { fontSize: 'var(--fs-sm)' } }, 'Ctrl Enter to save'),
        h('button', { class: 'btn', onClick: m.close }, 'Cancel'), h('button', { class: 'btn primary', onClick: save }, note ? 'Save' : 'Add note'));
    },
  });
}

export function quickTask(link) {
  modal({
    title: link ? `New task for ${recordName(link.type, link.id)}` : 'New task', width: 520,
    body: (b) => b.append(taskComposer({ link, autofocus: true, cache: false, placeholder: link ? 'What needs doing?' : undefined })),
    footer: (f, m) => {
      f.append(h('span', { class: 'faint grow', style: { fontSize: 'var(--fs-sm)' } }, 'Enter adds the task and keeps this open for the next one.'),
        h('button', { class: 'btn', onClick: m.close }, 'Done'));
    },
  });
}

export const todaysTasks = () => (state.rows.tasks || []).filter((t) => !t.done_at && t.due_date && t.due_date <= todayISO());
