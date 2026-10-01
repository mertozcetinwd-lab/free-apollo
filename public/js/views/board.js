/**
 * The deal board. Columns are pipeline stages with their count and total value. Cards drag with
 * the pointer (mouse or touch) or the keyboard: focus a card, Space to pick up, ← → to move,
 * Space to drop, Escape to cancel. Open deals with no open task carry a red "No next step" flag
 * (Pipedrive's rule: every open deal needs a next activity).
 */

import { h } from '../dom.js';
import { icon, typeIcon } from '../icons.js';
import { fmtMoney, fmtDate, daysBetween, stageTotals, dueBucket } from '../logic.js';
import { state, ctx } from '../store.js';
import { nav } from '../nav.js';
import { valueNode } from '../ui/values.js';

let live = null;
function announce(text) {
  if (!live) { live = h('div', { class: 'sr-only', 'aria-live': 'assertive' }); document.body.append(live); }
  live.textContent = text;
}

export function renderBoard(root, { rows, fields, config, onMove }) {
  const c = ctx();
  const stages = [...state.meta.stages].sort((a, b) => a.position - b.position);
  const totals = stageTotals(rows, stages);
  const cardKeys = (config.cardFields || ['company_id', 'close_date']).filter((k) => !['name', 'stage', 'value_cents'].includes(k));
  const cardFields = cardKeys.map((k) => fields.find((f) => f.key === k)).filter(Boolean);
  const byStage = new Map(stages.map((s) => [s.key, []]));
  for (const r of rows) (byStage.get(r.stage) || byStage.set(r.stage, []).get(r.stage)).push(r);
  const ids = rows.map((r) => r.id);
  const board = h('div', { class: 'board', role: 'list', 'aria-label': 'Pipeline' });

  const card = (r, s) => {
    const open = s.kind === 'open';
    const days = daysBetween(r.stage_changed_at);
    const due = r.next_due ? dueBucket(r.next_due, c.today) : null;
    const el = h('div', {
      class: 'card', tabIndex: 0, role: 'listitem', 'data-id': r.id,
      'aria-label': `${r.name}, ${fmtMoney(r.value_cents, c.currency)}, ${s.name}. Space to move.`,
    },
    h('div', { class: 't' }, r.name),
    cardFields.map((f) => {
      const v = f.custom ? r.extra?.[f.key] : r[f.key];
      if (v === null || v === undefined || v === '') return null;
      return h('div', { class: 'meta' }, icon(typeIcon(f.type, f.to), 13), h('span', { class: 'ellipsis' }, valueNode(r, f, 'card')));
    }),
    h('div', { class: 'foot' },
      r.value_cents ? h('span', { class: 'val num' }, fmtMoney(r.value_cents, c.currency)) : h('span', null, 'No value'),
      h('span', { class: 'grow' }),
      open && !r.open_tasks ? h('span', { class: 'flag', title: 'No open task: add a next step' }, icon('flag', 12, 2), 'No next step') : null,
      open && r.next_due ? h('span', { class: ['due', due === 'overdue' && 'overdue'], title: 'Next task due' }, icon('calendar', 12), fmtDate(r.next_due, c.dateFormat).replace(/, \d{4}$/, '')) : null,
      open ? h('span', { class: 'num', title: `${days} days in ${s.name}` }, icon('clock', 12), ` ${days}d`) : null));
    wireDrag(el, r);
    return el;
  };

  for (const s of stages) {
    const list = byStage.get(s.key) || [];
    const t = totals.get(s.key);
    const body = h('div', { class: 'col-body', 'data-stage': s.key }, list.map((r) => card(r, s)));
    board.append(h('section', { class: 'col', 'data-stage': s.key, 'data-c': s.color, 'aria-label': s.name },
      h('div', { class: 'col-head' },
        h('span', { class: 'dot', 'data-c': s.color }), h('span', { class: 'name' }, s.name), h('span', { class: 'n num' }, list.length),
        h('span', { class: 'tot num' }, t && t.cents ? fmtMoney(t.cents, c.currency, { compact: true }) : '')),
      body,
      h('button', { class: 'btn ghost sm col-add', onClick: () => nav.create('deals', { stage: s.key }) }, icon('plus', 14), 'New deal')));
  }
  root.append(board);

  /* ---------- pointer drag */
  function wireDrag(el, r) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || el.classList.contains('kbd-lifted')) return;
      const sx = e.clientX; const sy = e.clientY;
      let ghost = null; let ph = null; let target = null; let ox = 0; let oy = 0;
      const scroller = root;
      const move = (ev) => {
        if (!ghost) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          const rect = el.getBoundingClientRect();
          ox = sx - rect.left; oy = sy - rect.top;
          ghost = el.cloneNode(true); ghost.classList.add('lifted'); ghost.style.width = rect.width + 'px';
          document.body.append(ghost);
          ph = h('div', { class: 'card placeholder', style: { height: rect.height + 'px' } });
          el.after(ph); el.style.display = 'none';
          document.body.style.cursor = 'grabbing';
        }
        ghost.style.left = ev.clientX - ox + 'px'; ghost.style.top = ev.clientY - oy + 'px';
        const col = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => n.classList?.contains('col'));
        board.querySelectorAll('.col.drop').forEach((n) => n !== col && n.classList.remove('drop'));
        if (col) {
          col.classList.add('drop'); target = col.dataset.stage;
          const bodyEl = col.querySelector('.col-body');
          const after = [...bodyEl.querySelectorAll('.card:not(.placeholder)')].filter((n) => n.style.display !== 'none')
            .find((n) => { const b = n.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
          if (after) after.before(ph); else bodyEl.append(ph);
        }
        const b = scroller.getBoundingClientRect();
        if (ev.clientX > b.right - 60) scroller.scrollLeft += 14; else if (ev.clientX < b.left + 60) scroller.scrollLeft -= 14;
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        document.body.style.cursor = '';
        if (!ghost) { nav.openRecord('deals', r.id, ids); return; }
        ghost.remove(); ph.remove(); el.style.display = '';
        board.querySelectorAll('.col.drop').forEach((n) => n.classList.remove('drop'));
        if (target && target !== r.stage) onMove(r, target, el);
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });

    /* ---------- keyboard drag */
    el.addEventListener('keydown', (e) => {
      const lifted = el.classList.contains('kbd-lifted');
      const colOf = () => el.closest('.col');
      if (e.key === 'Enter' && !lifted) { e.preventDefault(); nav.openRecord('deals', r.id, ids); return; }
      if (e.key === ' ') {
        e.preventDefault();
        if (!lifted) { el.classList.add('kbd-lifted'); announce(`Picked up ${r.name}. Left and right arrows move it, Space drops it, Escape cancels.`); }
        else {
          el.classList.remove('kbd-lifted');
          const to = colOf().dataset.stage;
          if (to !== r.stage) onMove(r, to, el); else announce('Dropped in the same stage.');
        }
        return;
      }
      if (lifted && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        const col = e.key === 'ArrowRight' ? colOf().nextElementSibling : colOf().previousElementSibling;
        if (col) { col.querySelector('.col-body').prepend(el); el.focus(); el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); announce(`Over ${col.getAttribute('aria-label')}`); }
        return;
      }
      if (lifted && e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        el.classList.remove('kbd-lifted');
        board.querySelector(`.col-body[data-stage="${r.stage}"]`).prepend(el); el.focus();
        announce('Move cancelled.');
        return;
      }
      if (!lifted && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const sib = e.key === 'ArrowDown' ? el.nextElementSibling : el.previousElementSibling;
        sib?.focus();
      }
    });
  }
}
