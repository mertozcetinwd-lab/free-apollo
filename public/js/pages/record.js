/**
 * A record: in a side panel over the list (default) or as its own page. Name and every field edit
 * in place; deals get a stage bar with the days spent in each stage and Won / Lost buttons; the
 * timeline, notes and tasks sit in tabs with counts. ↑ ↓ walk the list the record was opened from.
 */

import { h, mount } from '../dom.js';
import { icon, typeIcon } from '../icons.js';
import { OBJECTS } from '../schema.js';
import { stageTimeline, fmtMoney, fmtDate, localDate } from '../logic.js';
import { state, ctx, fields as fieldsOf, updateRecord, deleteRecord, fetchActivity, stagesMap, setting, changed } from '../store.js';
import { nav } from '../nav.js';
import { api } from '../api.js';
import { menu, listbox, toast } from '../ui/overlay.js';
import { avatar, valueNode, stagePill, recordChip } from '../ui/values.js';
import { editField } from '../ui/editors.js';
import { activityItem } from '../ui/activity.js';
import { taskComposer, taskRow, sortTasks, noteCard, openNote } from '../ui/work.js';

const view = { key: null, tab: null, acts: null, actsKey: null, loading: null, showDone: false, evidence: null, evidenceKey: null, evidenceLoading: null, evidenceError: null };

function ensureEvidence(object, id) {
  if (!['people', 'companies'].includes(object)) return;
  const key = `${object}:${id}`;
  if (view.evidenceKey === key || view.evidenceLoading === key || view.evidenceError) return;
  view.evidenceLoading = key;
  api.get(`/prospect/evidence/${object}/${id}`).then((rows) => {
    if (view.evidenceLoading !== key) return;
    view.evidence = rows; view.evidenceKey = key; view.evidenceLoading = null; view.evidenceError = null; changed();
  }).catch((e) => { if (view.evidenceLoading === key) { view.evidenceLoading = null; view.evidenceError = e.message; changed(); } });
}

function ensureActivity(object, id) {
  const key = `${object}:${id}:${state.activityRev}`;
  if (view.actsKey === key || view.loading === key) return;
  view.loading = key;
  fetchActivity(object, id).then((rows) => {
    if (view.loading !== key) return;
    view.acts = rows; view.actsKey = key; view.loading = null; changed();
  }).catch(() => { view.loading = null; });
}

export function renderPanel(panel, route) {
  const { object, id } = route.open;
  const row = state.byId[object]?.get(id);
  if (!row) { nav.closeRecord(); return null; }
  const key = object + ':' + id;
  if (view.key !== key) { view.key = key; view.tab = view.tab || 'details'; view.acts = null; view.actsKey = null; view.showDone = false; view.evidence = null; view.evidenceKey = null; view.evidenceError = null; }
  ensureActivity(object, id);
  ensureEvidence(object, id);
  const navList = state.nav && state.nav.object === object ? state.nav.ids.filter((x) => state.byId[object].has(x)) : [];
  const idx = navList.indexOf(id);
  const go = (d) => { const next = navList[idx + d]; if (next) nav.openRecord(object, next, navList); };

  const head = h('div', { class: 'rec-head' },
    h('button', { class: 'btn ghost icon', 'aria-label': 'Close', title: 'Close (Esc)', onClick: () => nav.closeRecord() }, icon('x', 16)),
    navList.length > 1 ? [
      h('button', { class: 'btn ghost icon', 'aria-label': 'Previous record', title: 'Previous (↑)', disabled: idx <= 0, onClick: () => go(-1) }, icon('chevron-up', 16)),
      h('button', { class: 'btn ghost icon', 'aria-label': 'Next record', title: 'Next (↓)', disabled: idx < 0 || idx >= navList.length - 1, onClick: () => go(1) }, icon('chevron-down', 16)),
      idx >= 0 ? h('span', { class: 'rec-pos num' }, `${idx + 1} of ${navList.length}`) : null,
    ] : null,
    h('span', { class: 'grow' }),
    h('button', { class: 'btn ghost icon', 'aria-label': 'Open as a full page', title: 'Open as page', onClick: () => nav.go(`/${object}/${id}`) }, icon('expand', 15)),
    moreMenuBtn(object, row));

  const tabs = [['details', 'Details'], ['activity', 'Activity'], ['notes', 'Notes', notesOf(object, id).length], ['tasks', 'Tasks', openTasksOf(object, id).length]];
  if (!tabs.some(([k]) => k === view.tab)) view.tab = 'details';
  const body = h('div', { class: 'rec-scroll' },
    identity(object, row),
    object === 'deals' ? dealProgress(row) : null,
    actions(object, row),
    tabBar(tabs),
    view.tab === 'details' ? [detailsSection(object, row), evidenceSection(object, row), related(object, row)] : tabContent(object, row));
  mount(panel, head, body);
  return {
    onKey(e) {
      if (e.key === 'ArrowUp' || e.key === 'k') { go(-1); return true; }
      if (e.key === 'ArrowDown' || e.key === 'j') { go(1); return true; }
      if (e.key === 't') { view.tab = 'tasks'; changed(); requestAnimationFrame(() => panel.querySelector('.composer input')?.focus()); return true; }
      if (e.key === 'n') { openNote(null, { link: { type: object, id } }); return true; }
      return false;
    },
  };
}

export function renderRecordPage({ top, toolbar, content }, route) {
  const { object, id } = route;
  const def = OBJECTS[object];
  const row = state.byId[object]?.get(id);
  toolbar.hidden = true;
  if (!row) {
    mount(top, h('div', { class: 'title' }, h('a', { class: 'crumb', href: '/' + object, onClick: (e) => { e.preventDefault(); nav.go('/' + object); } }, def.plural)));
    mount(content, h('div', { class: 'empty' }, h('h2', null, `This ${def.singular.toLowerCase()} is gone`), h('p', null, 'It was deleted, or the link is wrong.'),
      h('button', { class: 'btn', onClick: () => nav.go('/' + object) }, `Back to ${def.plural.toLowerCase()}`)));
    return null;
  }
  const key = object + ':' + id;
  if (view.key !== key) { view.key = key; view.tab = 'activity'; view.acts = null; view.actsKey = null; view.showDone = false; view.evidence = null; view.evidenceKey = null; view.evidenceError = null; }
  if (view.tab === 'details') view.tab = 'activity';
  ensureActivity(object, id);
  ensureEvidence(object, id);
  const navList = state.nav && state.nav.object === object ? state.nav.ids.filter((x) => state.byId[object].has(x)) : [];
  const idx = navList.indexOf(id);
  const go = (d) => { const next = navList[idx + d]; if (next) nav.go(`/${object}/${next}`); };

  mount(top,
    h('div', { class: 'title' },
      h('a', { class: 'crumb', href: '/' + object, onClick: (e) => { e.preventDefault(); nav.go('/' + object); } }, def.plural),
      h('span', { class: 'faint' }, '/'), h('span', { class: 'ellipsis' }, row[def.primary] || 'Untitled'),
      idx >= 0 ? h('span', { class: 'count num' }, `(${idx + 1}/${navList.length})`) : null),
    h('span', { class: 'grow' }),
    navList.length > 1 ? [
      h('button', { class: 'btn ghost icon', 'aria-label': 'Previous record', disabled: idx <= 0, onClick: () => go(-1) }, icon('chevron-up', 16)),
      h('button', { class: 'btn ghost icon', 'aria-label': 'Next record', disabled: idx < 0 || idx >= navList.length - 1, onClick: () => go(1) }, icon('chevron-down', 16)),
    ] : null,
    moreMenuBtn(object, row));

  const tabs = [['activity', 'Activity'], ['notes', 'Notes', notesOf(object, id).length], ['tasks', 'Tasks', openTasksOf(object, id).length]];
  mount(content, h('div', { class: 'recpage' },
    h('div', { class: 'left' }, identity(object, row), actions(object, row), detailsSection(object, row), evidenceSection(object, row), related(object, row)),
    h('div', { class: 'right' }, object === 'deals' ? h('div', { style: { paddingTop: '18px' } }, dealProgress(row)) : null, tabBar(tabs), tabContent(object, row))));
  return {
    onKey(e) {
      if (e.key === 'ArrowUp' || e.key === 'k') { go(-1); return true; }
      if (e.key === 'ArrowDown' || e.key === 'j') { go(1); return true; }
      if (e.key === 't') { view.tab = 'tasks'; changed(); requestAnimationFrame(() => content.querySelector('.composer input')?.focus()); return true; }
      if (e.key === 'n') { openNote(null, { link: { type: object, id } }); return true; }
      return false;
    },
  };
}

/* ---------------------------------------------------------------- parts */

function moreMenuBtn(object, row) {
  return h('button', { class: 'btn ghost icon', 'aria-label': 'Record actions', onClick: (e) => menu(e.currentTarget, [
    { label: 'Copy link', icon: 'link', onSelect: async () => { await navigator.clipboard?.writeText(`${location.origin}/${object}/${row.id}`).catch(() => {}); toast('Link copied'); } },
    { label: 'Add task', icon: 'check-square', hint: 'T', onSelect: () => { view.tab = 'tasks'; changed(); } },
    { label: 'Add note', icon: 'file-text', hint: 'N', onSelect: () => openNote(null, { link: { type: object, id: row.id } }) },
    { sep: true },
    { label: `Delete ${OBJECTS[object].singular.toLowerCase()}`, icon: 'trash', danger: true, onSelect: () => { nav.closeRecord(); deleteRecord(object, row.id); } },
  ], { align: 'end' }) }, icon('more', 16));
}

function identity(object, row) {
  const def = OBJECTS[object];
  const name = h('span', { class: 'nm', contentEditable: 'plaintext-only', spellcheck: 'false', role: 'textbox', 'aria-label': 'Name' }, row[def.primary] || '');
  if (name.contentEditable !== 'plaintext-only') name.contentEditable = 'true';
  const commit = () => {
    const v = name.textContent.replace(/\s+/g, ' ').trim();
    if (!v) { name.textContent = row[def.primary]; return; }
    if (v !== row[def.primary]) updateRecord(object, row.id, { [def.primary]: v }).catch(() => {});
  };
  name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); name.blur(); } if (e.key === 'Escape') { name.textContent = row[def.primary]; name.blur(); } });
  name.addEventListener('blur', commit);
  const c = ctx();
  let sub = null;
  if (object === 'people') sub = [row.title ? h('span', null, row.title) : null, row.title && row.company_id ? h('span', { class: 'faint' }, 'at') : null, row.company_id ? recordChip('companies', row.company_id) : null];
  if (object === 'companies') sub = [row.domain ? h('a', { href: 'https://' + row.domain, target: '_blank', rel: 'noopener noreferrer' }, row.domain) : null, row.industry ? h('span', { class: 'faint' }, '· ' + row.industry) : null];
  if (object === 'deals') sub = [h('b', { class: 'num', style: { color: 'var(--ink)' } }, fmtMoney(row.value_cents, c.currency)), row.company_id ? recordChip('companies', row.company_id) : null];
  return h('div', { class: 'rec-id' }, avatar(object, row, { size: 'lg' }),
    h('div', { style: { minWidth: 0, flex: 1 } }, name, h('div', { class: 'sub' }, sub)));
}

function dealProgress(row) {
  const stages = [...state.meta.stages].sort((a, b) => a.position - b.position);
  const current = stagesMap().get(row.stage);
  const events = (view.acts || []).filter((a) => a.record_type === 'deals' && a.record_id === row.id);
  const tl = stageTimeline(row, events, stages);
  const move = (key, extra = {}) => updateRecord('deals', row.id, { stage: key, ...extra }, { undoLabel: `Moved to ${stagesMap().get(key)?.name}` }).catch(() => {});
  const bar = h('div', { class: 'stagebar', role: 'group', 'aria-label': 'Stage' }, tl.map((s) => h('button', {
    class: ['seg', s.state], 'data-c': s.color, title: `${s.name}${s.state !== 'future' ? ` · ${s.days} day${s.days === 1 ? '' : 's'}` : ''}`,
    'aria-current': s.state === 'current' ? 'step' : null, onClick: () => s.key !== row.stage && move(s.key),
  }, h('span', { class: 'ellipsis' }, s.name), s.state !== 'future' ? h('span', { class: 'd num' }, `${s.days}d`) : null)));
  let closeRow;
  if (current && current.kind !== 'open') {
    const lastOpen = [...events].filter((e) => e.kind === 'stage' && e.data.to === row.stage).map((e) => e.data.from).pop() || stages.find((s) => s.kind === 'open')?.key;
    closeRow = h('div', { class: 'closed-banner', 'data-c': current.color },
      icon(current.kind === 'won' ? 'check-circle' : 'x-circle', 16),
      h('span', { class: 'grow' }, current.kind === 'won' ? 'Won' : 'Lost', row.lost_reason && current.kind === 'lost' ? ` · ${row.lost_reason}` : '',
        h('span', { class: 'faint' }, ` · ${fmtDate(localDate(row.stage_changed_at), ctx().dateFormat)}`)),
      h('button', { class: 'btn sm', onClick: () => move(lastOpen, { lost_reason: null }) }, 'Reopen'));
  } else {
    const won = stages.find((s) => s.kind === 'won'); const lost = stages.find((s) => s.kind === 'lost');
    closeRow = h('div', { class: 'closebtns' },
      won ? h('button', { class: 'btn won', onClick: () => move(won.key) }, icon('check-circle', 15), 'Mark won') : null,
      lost ? h('button', { class: 'btn lost', onClick: (e) => listbox(e.currentTarget, {
        placeholder: 'Why was it lost?', width: 260,
        items: [...setting('lost_reasons', []).map((x) => ({ label: x, value: x })), { sep: true }, { label: 'No reason', value: null, icon: 'x' }],
        onPick: (it) => move(lost.key, { lost_reason: it.value }), create: (x) => move(lost.key, { lost_reason: x }),
      }) }, icon('x-circle', 15), 'Mark lost') : null);
  }
  return [bar, closeRow];
}

function actions(object, row) {
  return h('div', { class: 'rec-actions' },
    h('button', { class: 'btn sm', onClick: () => { view.tab = 'tasks'; changed(); requestAnimationFrame(() => document.querySelector('.composer input')?.focus()); } }, icon('check-square', 14), 'Task'),
    h('button', { class: 'btn sm', onClick: () => openNote(null, { link: { type: object, id: row.id } }) }, icon('file-text', 14), 'Note'));
}

function evidenceSection(object, row) {
  if (!['people', 'companies'].includes(object)) return null;
  const key = `${object}:${row.id}`;
  const items = view.evidenceKey === key ? view.evidence : null;
  return h('div', { class: 'sect' }, h('div', { class: 'sect-h' }, 'Source evidence'),
    view.evidenceError ? h('div', { class: 'faint' }, `Could not load evidence: ${view.evidenceError}`,
      h('button', { class: 'btn ghost sm', onClick: () => { view.evidenceError = null; ensureEvidence(object, row.id); } }, 'Retry'))
      : items ? (items.length ? h('div', { class: 'prospect-evidence' }, items.map((e) => h('div', null,
        h('b', null, `${e.field === 'record' ? 'Record' : e.field.replaceAll('_', ' ')}: ${e.source}`),
        h('span', null, e.status === 'unknown' ? `Date unknown · imported ${e.observed_at.slice(0, 10)}` : `${e.status} · ${e.observed_at.slice(0, 10)}`),
        e.detail ? h('small', null, e.detail) : null)))
        : h('div', { class: 'faint' }, 'No source evidence recorded. Verification is unknown.'))
        : h('div', { class: 'faint' }, 'Loading source evidence…'));
}

function tabBar(tabs) {
  return h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, label, n]) => h('button', {
    class: ['tab', view.tab === k && 'on'], role: 'tab', 'aria-selected': view.tab === k ? 'true' : 'false',
    onClick: () => { view.tab = k; changed(); },
  }, label, n !== undefined ? h('span', { class: 'n num' }, n) : null)));
}

function detailsSection(object, row) {
  const def = OBJECTS[object];
  const fields = fieldsOf(object).filter((f) => f.key !== def.primary);
  return h('div', { class: 'sect' },
    h('div', { class: 'sect-h' }, 'Details', h('span', { class: 'grow' }),
      h('button', { class: 'btn ghost sm', onClick: () => nav.go('/settings/fields?object=' + object) }, icon('plus', 13), 'Field')),
    h('div', { class: 'fields' }, fields.map((f) => h('div', { class: 'frow' },
      h('div', { class: 'fl' }, icon(typeIcon(f.type, f.to), 14), h('span', { class: 'ellipsis' }, f.label)),
      h('div', {
        class: ['fv', !f.readonly && 'editable'], role: f.readonly ? null : 'button', tabIndex: f.readonly ? null : 0,
        onClick: f.readonly ? null : (e) => editField(e.currentTarget, object, row, f),
        onKeydown: f.readonly ? null : (e) => { if (e.key === 'Enter') { e.preventDefault(); editField(e.currentTarget, object, row, f); } },
      }, valueNode(row, f, 'field'))))));
}

function related(object, row) {
  const c = ctx();
  const list = (title, rows, render, addLabel, onAdd) => h('div', { class: 'sect' },
    h('div', { class: 'sect-h' }, title, h('span', { class: 'faint num' }, rows.length), h('span', { class: 'grow' }),
      h('button', { class: 'btn ghost sm', onClick: onAdd }, icon('plus', 13), addLabel)),
    rows.length ? h('div', { class: 'rel-list' }, rows.map(render)) : h('div', { class: 'faint' }, 'None yet'));
  const dealItem = (d) => h('div', { class: 'rel-item', onClick: () => nav.openRecord('deals', d.id) }, avatar('deals', d),
    h('span', { class: 'ellipsis' }, d.name), stagePill(d.stage), h('span', { class: 'r num' }, fmtMoney(d.value_cents, c.currency)));
  if (object === 'companies') {
    const people = state.rows.people.filter((p) => p.company_id === row.id);
    const deals = state.rows.deals.filter((d) => d.company_id === row.id);
    return [
      list('People', people, (p) => h('div', { class: 'rel-item', onClick: () => nav.openRecord('people', p.id) }, avatar('people', p),
        h('span', { class: 'ellipsis' }, p.name), h('span', { class: 'r ellipsis' }, p.title || p.email || '')), 'Person', () => nav.create('people', { company_id: row.id })),
      list('Deals', deals, dealItem, 'Deal', () => nav.create('deals', { company_id: row.id })),
    ];
  }
  if (object === 'people') {
    const deals = state.rows.deals.filter((d) => d.person_id === row.id);
    return list('Deals', deals, dealItem, 'Deal', () => nav.create('deals', { person_id: row.id, company_id: row.company_id || undefined }));
  }
  return null;
}

const notesOf = (object, id) => (state.rows.notes || []).filter((n) => n.record_type === object && n.record_id === id);
const tasksOf = (object, id) => (state.rows.tasks || []).filter((t) => t.record_type === object && t.record_id === id);
const openTasksOf = (object, id) => tasksOf(object, id).filter((t) => !t.done_at);

function tabContent(object, row) {
  if (view.tab === 'notes') {
    const notes = notesOf(object, row.id).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return h('div', { class: 'sect stack' },
      h('button', { class: 'composer', style: { textAlign: 'left', color: 'var(--ink-3)' }, onClick: () => openNote(null, { link: { type: object, id: row.id } }) }, 'Write a note…'),
      notes.length ? notes.map((n) => noteCard(n, { showLink: false })) : h('div', { class: 'faint', style: { padding: '8px 0' } }, 'No notes yet. Press N to write one.'));
  }
  if (view.tab === 'tasks') {
    const tasks = sortTasks(tasksOf(object, row.id));
    const open = tasks.filter((t) => !t.done_at); const done = tasks.filter((t) => t.done_at);
    return h('div', { class: 'sect' },
      taskComposer({ link: { type: object, id: row.id }, placeholder: 'Add a task…' }),
      h('div', { style: { marginTop: '10px' } }, open.map((t) => taskRow(t, { showLink: false }))),
      !open.length ? h('div', { class: 'faint', style: { padding: '6px 0' } }, object === 'deals' ? 'No next step yet. Add a task so this deal keeps moving.' : 'Nothing to do here.') : null,
      done.length ? h('button', { class: 'btn ghost sm', style: { marginTop: '8px' }, onClick: () => { view.showDone = !view.showDone; changed(); } },
        icon(view.showDone ? 'chevron-down' : 'chevron-right', 13), `${done.length} completed`) : null,
      view.showDone ? done.map((t) => taskRow(t, { showLink: false })) : null);
  }
  // activity
  if (!view.acts) return h('div', { class: 'sect stack' }, [1, 2, 3].map(() => h('div', { class: 'row' }, h('div', { class: 'skel', style: { width: '24px', height: '24px', borderRadius: '50%' } }), h('div', { class: 'skel', style: { width: '60%' } }))));
  return h('div', { class: 'sect' }, view.acts.length
    ? h('div', { class: 'timeline' }, view.acts.map((a) => activityItem(a, { object, id: row.id })))
    : h('div', { class: 'faint' }, 'Nothing has happened yet.'));
}
