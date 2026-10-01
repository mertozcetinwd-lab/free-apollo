/**
 * Home: what needs doing today and where the pipeline stands. Four numbers, the pipeline by stage,
 * tasks due, deals with no next step, and what changed recently.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { fmtMoney, stageTotals, todayISO, addDays, localDate } from '../logic.js';
import { state, ctx, fetchActivity, changed } from '../store.js';
import { nav } from '../nav.js';
import { taskRow, sortTasks, todaysTasks } from '../ui/work.js';
import { activityItem } from '../ui/activity.js';
import { avatar, stagePill } from '../ui/values.js';

const feed = { rows: null, rev: -1, loading: false };

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? 'Working late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}

export function renderHome({ top, toolbar, content }) {
  toolbar.hidden = true;
  const c = ctx();
  const today = todayISO();
  const stages = [...state.meta.stages].sort((a, b) => a.position - b.position);
  const openKeys = new Set(stages.filter((s) => s.kind === 'open').map((s) => s.key));
  const wonKeys = new Set(stages.filter((s) => s.kind === 'won').map((s) => s.key));
  const deals = state.rows.deals || [];
  const open = deals.filter((d) => openKeys.has(d.stage));
  const monthStart = today.slice(0, 8) + '01';
  const wonMonth = deals.filter((d) => wonKeys.has(d.stage) && localDate(d.stage_changed_at) >= monthStart);
  const due = sortTasks(todaysTasks());
  const overdue = due.filter((t) => t.due_date < today).length;
  const weekAgo = addDays(today, -7);
  const newPeople = (state.rows.people || []).filter((p) => localDate(p.created_at) > weekAgo).length;
  const stuck = open.filter((d) => !d.open_tasks).sort((a, b) => (b.value_cents || 0) - (a.value_cents || 0)).slice(0, 6);
  const totals = stageTotals(open, stages);
  const openSum = open.reduce((a, d) => a + (Number(d.value_cents) || 0), 0);

  if (feed.rev !== state.activityRev && !feed.loading) {
    feed.loading = true;
    fetchActivity(null, null, 12).then((rows) => { feed.rows = rows; feed.rev = state.activityRev; feed.loading = false; changed(); }).catch(() => { feed.loading = false; });
  }

  mount(top, h('button', { class: 'btn ghost icon menu-btn', 'aria-label': 'Menu', onClick: () => document.querySelector('.app').classList.toggle('side-open') }, icon('sidebar', 16)),
    h('div', { class: 'title' }, icon('home', 15), 'Home'));

  const kpi = (label, ic, value, sub, onClick) => h('button', { class: 'kpi', style: { textAlign: 'left' }, onClick },
    h('span', { class: 'label' }, icon(ic, 13), label), h('span', { class: 'big num' }, value), h('span', { class: 'faint', style: { fontSize: 'var(--fs-sm)' } }, sub));

  mount(content, h('div', { class: 'page-pad' },
    h('h1', null, `${greeting()}.`),
    h('p', { class: 'muted', style: { margin: '4px 0 0' } }, new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })),
    h('div', { class: 'kpis' },
      kpi('Open pipeline', 'target', fmtMoney(openSum, c.currency, { compact: openSum >= 1e8 }), `${open.length} open deal${open.length === 1 ? '' : 's'}`, () => nav.go('/deals')),
      kpi('Won this month', 'check-circle', fmtMoney(wonMonth.reduce((a, d) => a + (Number(d.value_cents) || 0), 0), c.currency), `${wonMonth.length} deal${wonMonth.length === 1 ? '' : 's'}`, () => nav.go('/deals')),
      kpi('Due today', 'check-square', String(due.length), overdue ? `${overdue} overdue` : 'Nothing overdue', () => nav.go('/tasks')),
      kpi('New people', 'user', String(newPeople), 'in the last 7 days', () => nav.go('/people'))),
    h('div', { class: 'panels' },
      h('div', { class: 'stack', style: { gap: '12px' } },
        h('section', { class: 'card-box' },
          h('div', { class: 'h' }, h('h2', null, 'Pipeline'), h('button', { class: 'btn ghost sm', onClick: () => nav.go('/deals') }, 'Open board', icon('arrow-right', 13))),
          open.length ? [
            h('div', { class: 'pipe-strip', 'aria-hidden': 'true' }, stages.filter((s) => s.kind === 'open' && totals.get(s.key).cents > 0)
              .map((s) => h('span', { 'data-c': s.color, style: { flex: String(totals.get(s.key).cents) } }))),
            h('div', { class: 'pipe-rows' }, stages.filter((s) => s.kind === 'open').map((s) => {
              const t = totals.get(s.key);
              return h('div', { class: 'pipe-row', onClick: () => nav.go('/deals') }, h('span', { class: 'dot', 'data-c': s.color }), h('span', null, s.name),
                h('span', { class: 'n num' }, `${t.count} deal${t.count === 1 ? '' : 's'}`), h('b', { class: 'num' }, fmtMoney(t.cents, c.currency)));
            })),
          ] : h('div', { class: 'empty-mini' }, 'No open deals yet. ', h('button', { class: 'btn sm', onClick: () => nav.create('deals') }, 'Add a deal'))),
        h('section', { class: 'card-box' },
          h('div', { class: 'h' }, h('h2', null, 'Due today'), h('span', { class: 'faint num' }, due.length), h('button', { class: 'btn ghost sm', onClick: () => nav.go('/tasks') }, 'All tasks', icon('arrow-right', 13))),
          due.length ? due.slice(0, 8).map((t) => taskRow(t)) : h('div', { class: 'empty-mini' }, 'Nothing due. A good day to follow up with someone.'))),
      h('div', { class: 'stack', style: { gap: '12px' } },
        h('section', { class: 'card-box' },
          h('div', { class: 'h' }, h('h2', null, 'Deals with no next step'), h('span', { class: 'faint num' }, open.filter((d) => !d.open_tasks).length)),
          stuck.length ? h('div', { class: 'rel-list' }, stuck.map((d) => h('div', { class: 'rel-item', onClick: () => nav.openRecord('deals', d.id, stuck.map((x) => x.id)) },
            avatar('deals', d), h('span', { class: 'ellipsis' }, d.name), stagePill(d.stage), h('span', { class: 'r num' }, fmtMoney(d.value_cents, c.currency)))))
            : h('div', { class: 'empty-mini' }, open.length ? 'Every open deal has a task. Nice.' : 'No open deals.')),
        h('section', { class: 'card-box' },
          h('div', { class: 'h' }, h('h2', null, 'Recent activity')),
          feed.rows ? (feed.rows.length ? h('div', { class: 'timeline' }, feed.rows.map((a) => activityItem(a, null))) : h('div', { class: 'empty-mini' }, 'Nothing yet.'))
            : h('div', { class: 'stack' }, [1, 2, 3].map(() => h('div', { class: 'skel', style: { width: '80%' } }))))))));
}
