import { h } from '../dom.js';
import { api } from '../api.js';
import { state } from '../store.js';
import { nav } from '../nav.js';
import { toast } from '../ui/overlay.js';

const view = { input: { company_id: '', person_id: '', offer: '' }, result: null, busy: false, status: '' };
const redraw = () => { if (nav.current().page === 'prospect') nav.go(location.pathname); };

async function preview(form) {
  if (view.busy) return;
  view.input = Object.fromEntries(new FormData(form));
  view.busy = true; view.status = 'Preparing a source-backed draft…'; redraw();
  try {
    view.result = await api.post('/prospect/draft', { company_id: Number(view.input.company_id),
      person_id: view.input.person_id ? Number(view.input.person_id) : null, offer: view.input.offer });
    view.status = view.result.source ? 'A public source supports the opening. Review it before use.'
      : 'No cited observation was available. Replace the visible placeholder before use.';
  } catch (error) { view.result = null; view.status = `Draft stopped: ${error.message}`; }
  view.busy = false; redraw();
}

async function saveDraft(onSaved) {
  if (!view.result) return;
  const company = (state.rows.companies || []).find((row) => row.id === Number(view.input.company_id));
  try {
    const saved = await api.post('/prospect/sequences', { name: `First message · ${company?.name || 'Company'}`,
      description: 'Review this sourced first message before any manual use.',
      steps: [{ type: 'manual_email', delay_value: 0, delay_unit: 'days', variant: 'A',
        subject: view.result.subject, body: view.result.body }] });
    toast('Draft sequence saved. Nothing was sent.');
    onSaved(saved);
  } catch (error) { toast(error.message, { error: true }); }
}

export function draftView(onSaved) {
  const companies = state.rows.companies || [], people = state.rows.people || [];
  const form = h('form', { class: 'prospect-editor', onSubmit: (e) => { e.preventDefault(); preview(e.currentTarget); } },
    h('label', null, 'Company', h('select', { class: 'input', name: 'company_id' },
      h('option', { value: '' }, 'Choose a company'),
      companies.map((row) => h('option', { value: row.id, selected: String(row.id) === view.input.company_id }, row.name)))),
    h('label', null, 'Person, optional', h('select', { class: 'input', name: 'person_id' },
      h('option', { value: '' }, 'Use a first-name placeholder'),
      people.map((row) => h('option', { value: row.id, selected: String(row.id) === view.input.person_id }, row.name)))),
    h('label', null, 'Your offer', h('input', { class: 'input', name: 'offer', maxlength: 180,
      value: view.input.offer, placeholder: 'Example: a missed-call AI voice agent' })),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit', disabled: view.busy },
      view.busy ? 'Preparing…' : 'Preview first message')));
  return [h('div', { class: 'prospect-heading' }, h('div', null, h('h1', null, 'Message draft'),
    h('p', null, 'Prepare a first message from a saved company and its field evidence. Every unsupported observation stays a placeholder. Nothing sends.'))),
  companies.length ? form : h('div', { class: 'prospect-transfer' },
    h('p', null, 'Save a company before drafting a message.')),
  h('p', { role: 'status', class: 'prospect-import-status' }, view.status),
  view.result ? h('section', { class: 'prospect-transfer prospect-draft' },
    h('h2', null, view.result.subject),
    h('pre', null, view.result.body),
    view.result.source ? h('p', null, 'Opening source: ', h('a', { href: view.result.source.url,
      target: '_blank', rel: 'noopener noreferrer' }, view.result.source.label),
      ` · observed ${new Date(view.result.source.observed_at).toLocaleDateString()}`)
      : h('p', null, 'Opening source: unknown. Replace the placeholder after checking a public source.'),
    h('p', null, 'Review the role, claim, offer and placeholders before use.'),
    h('button', { class: 'btn primary', type: 'button', onClick: () => saveDraft(onSaved) }, 'Save as draft sequence')) : null];
}
