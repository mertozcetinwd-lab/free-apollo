/**
 * Ctrl K. Actions about what is on screen come first (the open record, the current page), then
 * create, then records matching what you type, then go-to with their G-then-letter shortcuts.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { OBJECTS, RECORD_OBJECTS } from '../schema.js';
import { state, saveSettings, applyAppearance, changed, recordName } from '../store.js';
import { nav } from '../nav.js';
import { modal } from './overlay.js';
import { score } from '../logic.js';
import { avatar } from './values.js';
import { openNote, quickTask } from './work.js';

const kb = (...k) => h('span', { class: 'hint' }, k.map((x) => h('kbd', null, x)));

export function openCommandMenu() {
  if (document.querySelector('.cmdk')) return;
  const route = nav.current();
  const open = route.open || (route.page === 'record' ? { object: route.object, id: route.id } : null);
  const theme = (t) => () => { try { localStorage.setItem('crm.theme', t); } catch {} saveSettings({ theme: t }); applyAppearance(); changed(); };

  const base = [];
  if (open && state.byId[open.object]?.has(open.id)) {
    const name = recordName(open.object, open.id);
    base.push({ group: name },
      { label: 'Add a task', icon: 'check-square', keys: ['T'], run: () => quickTask({ type: open.object, id: open.id }) },
      { label: 'Add a note', icon: 'file-text', keys: ['N'], run: () => openNote(null, { link: { type: open.object, id: open.id } }) },
      { label: 'Copy link', icon: 'link', run: () => navigator.clipboard?.writeText(`${location.origin}/${open.object}/${open.id}`) });
  }
  base.push({ group: 'Create' },
    { label: 'New person', icon: 'user', keys: route.object === 'people' ? ['C'] : null, run: () => nav.create('people') },
    { label: 'New company', icon: 'building', keys: route.object === 'companies' ? ['C'] : null, run: () => nav.create('companies') },
    { label: 'New deal', icon: 'target', keys: ['D'], run: () => nav.create('deals') },
    { label: 'New task', icon: 'check-square', keys: ['T'], run: () => quickTask(null) },
    { label: 'New note', icon: 'file-text', keys: ['N'], run: () => openNote(null) });
  base.push({ group: 'Go to' },
    { label: 'Home', icon: 'home', keys: ['G', 'H'], run: () => nav.go('/') },
    ...RECORD_OBJECTS.map((o) => ({ label: OBJECTS[o].plural, icon: OBJECTS[o].icon, keys: ['G', { people: 'P', companies: 'C', deals: 'D' }[o]], run: () => nav.go('/' + o) })),
    { label: 'Tasks', icon: 'check-square', keys: ['G', 'T'], run: () => nav.go('/tasks') },
    { label: 'Notes', icon: 'file-text', keys: ['G', 'N'], run: () => nav.go('/notes') },
    { label: 'Settings', icon: 'sliders', keys: ['G', 'S'], run: () => nav.go('/settings') },
    { label: 'Import a CSV', icon: 'upload', run: () => nav.go('/settings/data') },
    { label: 'Keyboard shortcuts', icon: 'keyboard', keys: ['?'], run: () => nav.go('/settings/shortcuts') });
  base.push({ group: 'Theme' },
    { label: 'Light theme', icon: 'sun', run: theme('light') },
    { label: 'Dark theme', icon: 'moon', run: theme('dark') },
    { label: 'Match system', icon: 'monitor', run: theme('system') });

  modal({
    className: 'cmdk',
    body: (b, m) => {
      b.style.padding = '0'; b.style.gap = '0';
      const input = h('input', { placeholder: 'Search people, companies, deals or type a command…', 'aria-label': 'Command menu', autocomplete: 'off' });
      const list = h('div', { class: 'cmdk-list', role: 'listbox' });
      b.append(h('div', { class: 'cmdk-input' }, icon('search', 16), input, h('kbd', null, 'Esc')), list,
        h('div', { class: 'cmdk-foot' }, h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), 'navigate'), h('span', null, h('kbd', null, '↵'), 'open'), h('span', null, h('kbd', null, 'Esc'), 'close')));
      let hl = 0; let flat = [];
      const run = (it) => { m.close(); it.run(); };
      const render = () => {
        const q = input.value.trim();
        let items;
        if (!q) items = base;
        else {
          const cmds = base.filter((x) => !x.group).map((x) => ({ ...x, s: score(x.label, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 6);
          const recs = RECORD_OBJECTS.flatMap((o) => (state.rows[o] || []).map((r) => {
            const extra = o === 'people' ? r.email : o === 'companies' ? r.domain : null;
            return { o, r, s: Math.max(score(r[OBJECTS[o].primary], q), extra ? score(extra, q) * 0.8 : 0) };
          })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 8)
            .map(({ o, r }) => ({ label: r[OBJECTS[o].primary], lead: avatar(o, r), sub: OBJECTS[o].singular, run: () => nav.openRecord(o, r.id) }));
          items = [...(recs.length ? [{ group: 'Records' }, ...recs] : []), ...(cmds.length ? [{ group: 'Commands' }, ...cmds] : [])];
        }
        flat = items.filter((x) => !x.group);
        hl = Math.min(hl, Math.max(0, flat.length - 1));
        let i = -1;
        mount(list, items.length ? items.map((it) => {
          if (it.group) return h('div', { class: 'pop-label' }, it.group);
          i++; const idx = i;
          return h('button', { class: ['pop-item', idx === hl && 'hl'], role: 'option', 'aria-selected': idx === hl ? 'true' : 'false', type: 'button',
            onMousemove: () => { if (hl !== idx) { hl = idx; paint(); } }, onClick: () => run(it) },
          it.lead || h('span', { class: 'ic' }, icon(it.icon, 16)), h('span', { class: 'ellipsis' }, it.label),
          it.sub ? h('span', { class: 'faint', style: { fontSize: 'var(--fs-sm)' } }, it.sub) : null,
          it.keys ? kb(...it.keys) : null);
        }) : h('div', { class: 'pop-empty' }, `Nothing matches “${q}”.`));
      };
      const paint = () => { [...list.querySelectorAll('.pop-item')].forEach((el, i) => el.classList.toggle('hl', i === hl)); list.querySelectorAll('.pop-item')[hl]?.scrollIntoView({ block: 'nearest' }); };
      input.addEventListener('input', () => { hl = 0; render(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); hl = (hl + 1) % Math.max(1, flat.length); paint(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); hl = (hl - 1 + flat.length) % Math.max(1, flat.length); paint(); }
        else if (e.key === 'Enter') { e.preventDefault(); if (flat[hl]) run(flat[hl]); }
      });
      render();
    },
  });
}
