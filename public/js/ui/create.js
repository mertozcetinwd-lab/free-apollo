/**
 * The create dialog for people, companies and deals: the main fields, "Create more" to keep it open
 * for the next one, and Ctrl Enter to save (Attio's pattern).
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { OBJECTS, cleanValue } from '../schema.js';
import { state, fields as fieldsOf, createRecord, stagesMap } from '../store.js';
import { nav } from '../nav.js';
import { modal, toast, listbox } from './overlay.js';
import { pickStage, pickRecord, pickDate } from './editors.js';
import { avatar } from './values.js';
import { fmtDate } from '../logic.js';

const SHOWN = {
  people: ['name', 'email', 'phone', 'title', 'company_id', 'tags'],
  companies: ['name', 'domain', 'industry', 'employees', 'city', 'tags'],
  deals: ['name', 'value_cents', 'stage', 'company_id', 'person_id', 'close_date'],
};
let createMore = false;

export function openCreate(object, defaults = {}) {
  const def = OBJECTS[object];
  const all = fieldsOf(object);
  const shown = [...SHOWN[object].map((k) => all.find((f) => f.key === k)).filter(Boolean), ...all.filter((f) => f.custom)];
  const values = {};
  const reset = () => {
    for (const k of Object.keys(values)) delete values[k];
    Object.assign(values, defaults);
    if (object === 'deals' && !values.stage) values.stage = state.meta.stages.find((s) => s.kind === 'open')?.key;
  };
  reset();

  modal({
    title: `New ${def.singular.toLowerCase()}`, width: 520,
    body: (b, m) => {
      const errors = new Map();
      const control = (f) => {
        const err = h('div', { class: 'field-error', hidden: true });
        errors.set(f.key, err);
        let el;
        if (['stage', 'relation', 'date', 'select'].includes(f.type)) {
          el = h('button', { class: 'btn picker-btn', type: 'button' });
          const paint = () => {
            const v = values[f.key];
            if (f.type === 'stage') { const s = stagesMap().get(v); mount(el, s ? [h('span', { class: 'dot', 'data-c': s.color }), s.name] : 'Choose a stage'); }
            else if (f.type === 'relation') { const r = v && state.byId[f.to]?.get(v); mount(el, r ? [avatar(f.to, r), r.name] : h('span', { class: 'faint' }, `Choose a ${OBJECTS[f.to].singular.toLowerCase()}`)); }
            else if (f.type === 'date') mount(el, icon('calendar', 14), v ? fmtDate(v) : h('span', { class: 'faint' }, 'Pick a date'));
            else mount(el, v || h('span', { class: 'faint' }, 'Choose…'));
          };
          el.addEventListener('click', () => {
            const done = (v) => { values[f.key] = v; paint(); el.focus(); };
            if (f.type === 'stage') pickStage(el, values[f.key], done);
            else if (f.type === 'relation') pickRecord(el, f.to, values[f.key], done, { allowClear: true });
            else if (f.type === 'date') pickDate(el, values[f.key], done);
            else listbox(el, { items: (f.options || []).map((o) => ({ label: o.value, value: o.value, lead: h('span', { class: 'dot', 'data-c': o.color }) })), onPick: (it) => done(it.value) });
          });
          paint();
        } else if (f.type === 'checkbox') {
          el = h('button', { class: 'switch', role: 'switch', type: 'button', 'aria-checked': values[f.key] ? 'true' : 'false', 'aria-label': f.label });
          el.addEventListener('click', () => { values[f.key] = !values[f.key]; el.setAttribute('aria-checked', values[f.key] ? 'true' : 'false'); });
        } else {
          el = h('input', {
            class: 'input', 'aria-label': f.label, name: f.key,
            value: f.type === 'currency' && values[f.key] != null ? values[f.key] / 100 : values[f.key] ?? '',
            placeholder: { name: object === 'people' ? 'Full name' : object === 'companies' ? 'Company name' : 'What is the deal?', email: 'name@example.com', domain: 'example.com', value_cents: '0.00', tags: 'comma, separated' }[f.key] || '',
            inputmode: ['number', 'currency'].includes(f.type) ? 'decimal' : f.type === 'email' ? 'email' : null,
          });
          el.addEventListener('input', () => {
            values[f.key] = f.type === 'currency' ? (el.value.trim() === '' ? null : Math.round(Number(el.value.replace(/[^0-9.\-]/g, '')) * 100)) : el.value;
            err.hidden = true; el.classList.remove('invalid');
          });
        }
        return h('div', { class: 'form-row' }, h('label', { class: 'label' }, f.label, f.required ? ' *' : ''), el, err);
      };
      b.append(...shown.map(control));
      m.submit = async () => {
        // Check each field on its own so the message lands under the right input.
        for (const f of shown) {
          const c = cleanValue(f, values[f.key]);
          if (c.ok) continue;
          const err = errors.get(f.key); err.textContent = c.error; err.hidden = false;
          const input = b.querySelector(`[name="${f.key}"]`);
          input?.classList.add('invalid'); (input || err).focus?.();
          return;
        }
        const payload = {};
        for (const f of shown) if (values[f.key] !== undefined && values[f.key] !== '') payload[f.key] = values[f.key];
        for (const [k, v] of Object.entries(defaults)) if (payload[k] === undefined) payload[k] = v;
        try {
          const row = await createRecord(object, payload);
          if (createMore) {
            toast(`Created ${row[def.primary]}`);
            reset();
            mount(b, ...shown.map(control));
            b.querySelector('input')?.focus();
          } else {
            m.close();
            toast(`Created ${row[def.primary]}`, { action: 'Open', onAction: () => nav.openRecord(object, row.id) });
          }
        } catch { /* toast already shown */ }
      };
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); m.submit(); }
        else if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); m.submit(); }
      });
    },
    footer: (f, m) => {
      const sw = h('button', { class: 'switch', role: 'switch', type: 'button', 'aria-checked': createMore ? 'true' : 'false', 'aria-label': 'Create more' });
      sw.addEventListener('click', () => { createMore = !createMore; sw.setAttribute('aria-checked', createMore ? 'true' : 'false'); });
      f.append(h('label', { class: 'row muted', style: { cursor: 'pointer' } }, sw, 'Create more'), h('span', { class: 'grow' }),
        h('button', { class: 'btn', onClick: m.close }, 'Cancel', h('kbd', null, 'Esc')),
        h('button', { class: 'btn primary', onClick: () => m.submit() }, `Create ${def.singular.toLowerCase()}`, h('kbd', null, 'Ctrl ↵')));
    },
  });
}
