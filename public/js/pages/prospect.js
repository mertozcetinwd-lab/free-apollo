import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { nav } from '../nav.js';
import { state } from '../store.js';
import { toast } from '../ui/overlay.js';
import { discover } from './discover.js';
import { draftView } from './draft.js';

const cache = { overview: null, lists: [], sequences: [], costs: [], members: null, listId: null, loading: false, error: null };
const link = (href, label, ic) => h('a', { class: 'btn', href, onClick: (e) => { e.preventDefault(); nav.go(href); } }, icon(ic, 15), label);
const btn = (label, ic, fn, cls = 'btn') => h('button', { class: cls, onClick: fn }, icon(ic, 15), label);
const fmtMoney = (micros) => '$' + ((micros || 0) / 1e6).toFixed(4);

async function load() {
  if (cache.loading) return;
  cache.loading = true; cache.error = null;
  try {
    const [overview, lists, sequences, costs] = await Promise.all([
      api.get('/prospect/overview'), api.get('/prospect/lists'), api.get('/prospect/sequences'), api.get('/prospect/costs'),
    ]);
    Object.assign(cache, { overview, lists, sequences, costs });
  } catch (e) { cache.error = e.message; }
  cache.loading = false;
  if (nav.current().page === 'prospect') nav.go(location.pathname);
}

export function renderProspect({ top, toolbar, content }, route) {
  const section = route.section || 'overview';
  if (!cache.overview && !cache.loading && !cache.error) queueMicrotask(load);
  mount(top, h('button', { class: 'btn ghost icon menu-btn', 'aria-label': 'Menu', onClick: () => document.querySelector('.app').classList.toggle('side-open') }, icon('sidebar', 16)),
    h('div', { class: 'title' }, icon('target', 17), 'Prospecting'), h('span', { class: 'grow' }),
    link('/people', 'People', 'users'), link('/companies', 'Companies', 'building'));
  mount(toolbar, h('nav', { class: 'prospect-tabs', 'aria-label': 'Prospecting' },
    ...[['overview', 'Overview'], ['discover', 'Find & enrich'], ['lists', 'Lists'], ['draft', 'Draft'], ['sequences', 'Sequences'], ['transfer', 'Import'], ['insights', 'Insights']]
      .map(([key, label]) => h('a', { class: section === key ? 'on' : '', href: '/prospect/' + key,
        'aria-current': section === key ? 'page' : null,
        onClick: (e) => { e.preventDefault(); nav.go('/prospect/' + key); } }, label))));
  if (cache.error) { mount(content, h('div', { class: 'prospect-error', role: 'alert' }, cache.error, btn('Retry', 'arrow-right', load))); return; }
  if (!cache.overview) { mount(content, h('div', { class: 'prospect-page', role: 'status' }, 'Loading prospecting workspace…')); return; }
  const views = { overview, discover, lists, draft: () => draftView((saved) => {
    cache.sequences.unshift({ ...saved, planned: 0 }); nav.go('/prospect/sequences');
  }), sequences, transfer, insights };
  mount(content, h('div', { class: 'prospect-page' }, (views[section] || overview)()));
}

function heading(title, description, action) {
  return h('div', { class: 'prospect-heading' }, h('div', null, h('h1', null, title), h('p', null, description)), action || null);
}
function number(label, value, note) {
  return h('div', { class: 'prospect-stat' }, h('span', null, label), h('strong', null, value), h('small', null, note));
}
function overview() {
  const o = cache.overview;
  return [heading('From discovery to a next step', 'Find public companies, search people with your key, gather evidence, save a list, then prepare a follow-up. Nothing sends from this app.'),
    h('div', { class: 'prospect-stats' }, number('People', o.people, 'Imported or entered'), number('Companies', o.companies, 'Imported or entered'),
      number('Open tasks', o.open_tasks, 'Manual work'), number('Provider spend', fmtMoney(o.charged_micros),
        o.uncertain_costs ? `${o.uncertain_costs} charge${o.uncertain_costs === 1 ? '' : 's'} unknown, check provider` : 'Only calls made here')),
    h('div', { class: 'prospect-workflow' },
      h('div', null, h('h2', null, 'Find and qualify'), h('p', null, 'Search public companies and optionally use a capped people provider. Save source-backed records here.'),
        h('div', { class: 'row' }, link('/prospect/discover', 'Find leads', 'search'), link('/people', 'Saved people', 'users'))),
      h('div', null, h('h2', null, 'Organize'), h('p', null, 'Make a list for a segment. Membership is explicit and can be reviewed before any follow-up.'),
        link('/prospect/lists', 'Open lists', 'list')),
      h('div', null, h('h2', null, 'Prepare outreach'), h('p', null, 'Build a source-backed first message, then arrange email drafts and manual tasks. Nothing sends.'),
        h('div', { class: 'row' }, link('/prospect/draft', 'Draft a message', 'mail'), link('/prospect/sequences', 'Open sequences', 'list')))),
    h('div', { class: 'prospect-note' }, icon('alert', 16),
      h('p', null, 'No global people database is included. Public company discovery and optional capped provider calls run inside this standalone app. A missing lookup stays unknown.'))];
}

let creatingList = false;
async function createNewList(form) {
  const name = form.querySelector('[name="name"]').value.trim();
  const kind = form.querySelector('[name="kind"]').value;
  try { const list = await api.post('/prospect/lists', { name, kind }); cache.listId = list.id; creatingList = false; await load(); await chooseList(list.id); }
  catch (e) { toast(e.message, { error: true }); }
}
async function chooseList(id) {
  cache.listId = id; cache.members = null;
  try { cache.members = await api.get(`/prospect/lists/${id}/members`); nav.go(location.pathname); }
  catch (e) { toast(e.message, { error: true }); }
}
async function addToList(list) {
  const rows = (state.rows[list.kind] || []).filter((r) => !cache.members.records.some((m) => m.id === r.id));
  if (!rows.length) return toast('There are no other records to add.');
  const select = document.querySelector('#prospect-add-record');
  const id = Number(select?.value);
  if (!id) return toast('Choose a record first.');
  try { cache.members = await api.post(`/prospect/lists/${list.id}/members`, { ids: [id] }); await load(); }
  catch (e) { toast(e.message, { error: true }); }
}
function lists() {
  const selected = cache.lists.find((l) => l.id === cache.listId);
  const available = selected && cache.members?.list.id === selected.id
    ? (state.rows[selected.kind] || []).filter((r) => !cache.members.records.some((m) => m.id === r.id)) : [];
  const form = h('form', { class: 'prospect-create-list', onSubmit: (e) => { e.preventDefault(); createNewList(e.currentTarget); } },
    h('label', null, 'List name', h('input', { class: 'input', name: 'name', required: true, maxlength: 80, placeholder: 'Example: Florida operators' })),
    h('label', null, 'Records', h('select', { class: 'input', name: 'kind' }, h('option', { value: 'people' }, 'People'), h('option', { value: 'companies' }, 'Companies'))),
    h('button', { class: 'btn primary', type: 'submit' }, 'Create list'));
  return [heading('Lists', 'Saved groups of people or companies. Add members deliberately.', btn('New list', 'plus', () => { creatingList = !creatingList; nav.go(location.pathname); }, 'btn primary')),
    creatingList ? form : null,
    h('div', { class: 'prospect-split' },
      h('div', { class: 'prospect-list-index' }, cache.lists.length ? cache.lists.map((l) =>
        h('button', { class: ['prospect-list-row', l.id === cache.listId && 'on'], onClick: () => chooseList(l.id) },
          h('strong', null, l.name), h('span', null, `${l.members} ${l.kind}`)))
        : h('p', { class: 'muted' }, 'No lists yet. Create one to start organizing records.')),
      selected ? h('div', { class: 'prospect-list-detail' }, h('div', { class: 'row' }, h('h2', null, selected.name), h('span', { class: 'grow' }),
        available.length ? [h('select', { class: 'input', id: 'prospect-add-record', 'aria-label': 'Record to add' },
          h('option', { value: '' }, 'Choose a record'), available.slice(0, 500).map((r) => h('option', { value: r.id }, r.name))),
          btn('Add record', 'plus', () => addToList(selected))] : null),
        cache.members?.list.id === selected.id ? (cache.members.records.length ? h('table', { class: 'prospect-table' },
          h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, selected.kind === 'people' ? 'Email' : 'Domain'), h('th', null, ''))),
          h('tbody', null, cache.members.records.map((r) => h('tr', null,
            h('td', null, r.name), h('td', null, selected.kind === 'people' ? r.email || 'Unknown' : r.domain || 'Unknown'),
            h('td', null, btn('Open', 'arrow-right', () => nav.openRecord(selected.kind, r.id), 'btn ghost sm'))))))
          : h('p', { class: 'muted' }, 'This list is empty.')) : h('p', { class: 'muted' }, 'Loading members…'))
        : h('div', { class: 'prospect-list-detail muted' }, 'Choose a list to see its members.'))];
}

let editing = null, planningId = null, planRows = [];
async function openPlan(id) {
  if (planningId === id) { planningId = null; nav.go(location.pathname); return; }
  try { planRows = await api.get(`/prospect/sequences/${id}/plan`); planningId = id; nav.go(location.pathname); }
  catch (e) { toast(e.message, { error: true }); }
}
async function planPeople(id, panel) {
  const ids = [...panel.querySelectorAll('input[type=checkbox]:checked')].map((x) => Number(x.value));
  if (!ids.length) return toast('Choose at least one person.');
  try { await api.post(`/prospect/sequences/${id}/plan`, { person_ids: ids }); planRows = await api.get(`/prospect/sequences/${id}/plan`); await load(); toast('People added to the plan. Nothing was sent.'); }
  catch (e) { toast(e.message, { error: true }); }
}
async function updatePlanState(sequenceId, personId, state) {
  try { await api.patch(`/prospect/sequences/${sequenceId}/plan/${personId}`, { state });
    planRows = await api.get(`/prospect/sequences/${sequenceId}/plan`); nav.go(location.pathname); }
  catch (e) { toast(e.message, { error: true }); }
}
function stepEditor(step = { type: 'email_draft', delay_days: 0, subject: '', body: '', variant: 'A' }) {
  const types = [
    ['email_draft', 'Email draft'], ['automatic_email_draft', 'Automatic email draft'], ['manual_email', 'Manual email'],
    ['phone_call', 'Phone call'], ['action_item', 'Action item'], ['manual_task', 'Manual task'],
    ['linkedin_connection', 'LinkedIn connection'], ['linkedin_message', 'LinkedIn message'],
    ['linkedin_view', 'LinkedIn profile view'], ['linkedin_post', 'LinkedIn post interaction'],
  ];
  const type = h('select', { class: 'input', 'aria-label': 'Step type' },
    types.map(([value, label]) => h('option', { value, selected: step.type === value }, label)));
  const delay = h('input', { class: 'input', type: 'number', min: 0, max: 365, value: step.delay_value ?? step.delay_days ?? 0, 'aria-label': 'Wait time' });
  const unit = h('select', { class: 'input', 'aria-label': 'Wait unit' },
    ['minutes', 'hours', 'days'].map((value) => h('option', { value, selected: (step.delay_unit || 'days') === value }, value)));
  const subject = h('input', { class: 'input', value: step.subject || '', placeholder: 'Subject or task title', 'aria-label': 'Subject or task title' });
  const body = h('textarea', { class: 'input', rows: 4, placeholder: 'Write a draft. Use {{placeholder}} where a claim needs evidence.', 'aria-label': 'Draft body' }, step.body || '');
  const variant = h('input', { class: 'input', value: step.variant || 'A', 'aria-label': 'Variant', maxlength: 30 });
  const el = h('div', { class: 'prospect-step' }, h('div', { class: 'row' }, type, h('label', null, 'Wait ', delay, unit), h('span', { class: 'grow' }),
    btn('Remove', 'trash', () => { el.remove(); }, 'btn ghost sm')), subject, body,
    h('label', { class: 'prospect-variant' }, 'Variant ', variant));
  el.read = () => ({ type: type.value, delay_value: Number(delay.value), delay_unit: unit.value,
    subject: subject.value, body: body.value, variant: variant.value });
  return el;
}
async function saveEditor(editor, id) {
  const schedule = { days: [...editor.querySelectorAll('[name="schedule_days"]:checked')].map((e) => Number(e.value)),
    start: editor.querySelector('[name="schedule_start"]').value, end: editor.querySelector('[name="schedule_end"]').value,
    timezone: editor.querySelector('[name="schedule_timezone"]').value };
  const rules = Object.fromEntries(['stop_on_reply', 'stop_on_meeting', 'pause_on_ooo', 'bounce_guard']
    .map((key) => [key, editor.querySelector(`[name="${key}"]`).checked]));
  rules.daily_cap = Number(editor.querySelector('[name="daily_cap"]').value);
  const payload = { name: editor.querySelector('[name="name"]').value, description: editor.querySelector('[name="description"]').value,
    steps: [...editor.querySelectorAll('.prospect-step')].map((el) => el.read()), schedule, rules };
  try { await (id ? api.put(`/prospect/sequences/${id}`, payload) : api.post('/prospect/sequences', payload)); editing = null; await load(); toast('Draft sequence saved.'); }
  catch (e) { toast(e.message, { error: true }); }
}
function sequenceEditor(seq) {
  const schedule = seq?.schedule || { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', timezone: 'local' };
  const rules = seq?.rules || { stop_on_reply: true, stop_on_meeting: true, pause_on_ooo: true, bounce_guard: true, daily_cap: 50 };
  const editor = h('div', { class: 'prospect-editor' },
    h('div', { class: 'row' }, h('h2', null, seq ? 'Edit sequence' : 'New sequence'), h('span', { class: 'grow' }),
      btn('Cancel', 'x', () => { editing = null; nav.go(location.pathname); }, 'btn ghost')),
    h('label', null, 'Name', h('input', { class: 'input', name: 'name', value: seq?.name || '', maxlength: 100 })),
    h('label', null, 'Purpose', h('input', { class: 'input', name: 'description', value: seq?.description || '', maxlength: 500 })),
    h('div', { class: 'prospect-steps' }, (seq?.steps || []).map(stepEditor)),
    h('div', { class: 'row' }, btn('Add step', 'plus', () => editor.querySelector('.prospect-steps').append(stepEditor())),
      btn('Add A/B test', 'plus', () => editor.querySelector('.prospect-steps').append(stepEditor({ type: 'email_draft', delay_value: 0,
        delay_unit: 'days', subject: '', body: '', variant: 'B' })), 'btn ghost')),
    h('section', { class: 'prospect-sequence-settings' }, h('h3', null, 'Schedule'),
      h('p', { class: 'muted' }, 'Planning window only. No automatic messages run.'),
      h('div', { class: 'row' }, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) =>
        h('label', null, h('input', { type: 'checkbox', name: 'schedule_days', value: i, checked: schedule.days.includes(i) }), day))),
      h('div', { class: 'row' }, h('label', null, 'Start ', h('input', { class: 'input', name: 'schedule_start', type: 'time', value: schedule.start })),
        h('label', null, 'End ', h('input', { class: 'input', name: 'schedule_end', type: 'time', value: schedule.end })),
        h('label', null, 'Time zone ', h('input', { class: 'input', name: 'schedule_timezone', value: schedule.timezone })))),
    h('section', { class: 'prospect-sequence-settings' }, h('h3', null, 'Rules and safety'),
      [['stop_on_reply', 'Stop on reply'], ['stop_on_meeting', 'Stop on meeting'], ['pause_on_ooo', 'Pause on out-of-office'],
        ['bounce_guard', 'Bounce guard']].map(([key, label]) => h('label', null,
          h('input', { type: 'checkbox', name: key, checked: rules[key] }), label)),
      h('label', null, 'Daily cap ', h('input', { class: 'input', name: 'daily_cap', type: 'number', min: 0, max: 1000, value: rules.daily_cap }))),
    h('div', { class: 'row' },
      h('span', { class: 'grow' }), btn('Save draft', 'check', () => saveEditor(editor, seq?.id), 'btn primary')));
  return editor;
}
function sequences() {
  return [heading('Sequences', 'Compose ordered drafts and manual tasks. Sending is disabled.', btn('New sequence', 'plus', () => { editing = { id: null }; nav.go(location.pathname); }, 'btn primary')),
    editing ? sequenceEditor(cache.sequences.find((s) => s.id === editing.id)) :
      cache.sequences.length ? h('div', { class: 'prospect-sequences' }, cache.sequences.map((s) => {
        const people = (state.rows.people || []).slice(0, 20);
        const panel = h('div', { class: 'prospect-plan', hidden: planningId !== s.id },
          h('p', null, 'Choose up to 20 people. If someone replies, pause the plan manually. Nothing sends.'),
          people.length ? people.map((p) => h('label', null, h('input', { type: 'checkbox', value: p.id }), p.name))
            : h('p', { class: 'muted' }, 'Add people before planning a sequence.'),
          btn('Save plan', 'check', () => planPeople(s.id, panel), 'btn primary'),
          planningId === s.id && planRows.length ? h('div', { class: 'prospect-planned' }, h('h3', null, 'Planned people'),
            planRows.map((r) => h('div', { class: 'row' }, h('span', null, r.name), h('span', { class: 'prospect-pill' }, r.state),
              btn(r.state === 'paused' ? 'Resume' : 'Pause', r.state === 'paused' ? 'check' : 'clock',
                () => updatePlanState(s.id, r.person_id, r.state === 'paused' ? 'planned' : 'paused'), 'btn ghost sm')))) : null);
        return h('div', { class: 'prospect-sequence' },
        h('div', { class: 'row' }, h('h2', null, s.name), h('span', { class: 'grow' }),
          h('span', { class: 'prospect-pill' }, 'Draft'), btn('Edit', 'pencil', () => { editing = { id: s.id }; nav.go(location.pathname); }),
          btn('Plan people', 'users', () => openPlan(s.id))),
        h('p', null, s.description || 'No description'),
        h('div', { class: 'prospect-step-summary' }, s.steps.length ? s.steps.map((step, i) => h('span', null,
          `${i + 1}. ${step.type.replaceAll('_', ' ')} · ${step.delay_value ?? step.delay_days ?? 0} ${step.delay_unit || 'days'} wait · Test ${step.variant || 'A'}`)) : 'No steps yet'),
        h('small', null, `${s.planned} people planned. No messages sent.`), panel);
      }))
        : h('div', { class: 'prospect-empty' }, icon('mail', 28), h('h2', null, 'Start with a draft'),
          h('p', null, 'Build a sequence of drafts and manual steps. No mailbox connection is required.'))];
}

async function importTransfer(input, output) {
  const file = input.files?.[0]; if (!file) return;
  output.textContent = 'Reading transfer file…';
  try {
    if (file.size > 2_000_000) throw new Error('Transfer files must be under 2 MB');
    const payload = JSON.parse(await file.text());
    if (!['free-apollo-transfer-v1', 'free-apollo-records-v1'].includes(payload.format) || !['people', 'companies'].includes(payload.kind) || !Array.isArray(payload.records)) throw new Error('This is not a Free Apollo records file');
    if (payload.records.length > 500) throw new Error('Transfer up to 500 records at a time');
    const total = { added: 0, existing: 0, skipped: 0 };
    for (let i = 0; i < payload.records.length; i += 5) {
      const r = await api.post('/prospect/transfer', { kind: payload.kind, records: payload.records.slice(i, i + 5) });
      for (const k of Object.keys(total)) total[k] += r[k];
      output.textContent = `${Math.min(i + 5, payload.records.length)} of ${payload.records.length} reviewed…`;
    }
    output.textContent = `${total.added} added, ${total.existing} already present, ${total.skipped} skipped. Review the records and source evidence.`;
    await load();
  } catch (e) { output.textContent = `Transfer stopped: ${e.message}. No unprocessed records were marked imported.`; }
  input.value = '';
}
function transfer() {
  const input = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Records JSON file' });
  const output = h('p', { role: 'status', class: 'prospect-import-status' }, 'No file selected.');
  input.addEventListener('change', () => importTransfer(input, output));
  return [heading('Import records', 'Bring your own data into this standalone workspace. The file stays on your computer until you choose it here.'),
    h('div', { class: 'prospect-transfer' }, h('h2', null, 'JSON records'),
      h('p', null, 'Choose a Free Apollo records file with field sources. Matching emails and domains stay as one record. See TRANSFER.md for the format.'),
      input, output,
      h('div', { class: 'prospect-note' }, icon('alert', 16), 'People without an email and companies without a domain are skipped for safe deduplication. Missing data is unknown.'),
      h('hr'), h('h2', null, 'CSV files'),
      h('p', null, 'The People and Companies pages also support mapped CSV import and export.'),
      h('div', { class: 'row' }, link('/people', 'Open People', 'users'), link('/companies', 'Open Companies', 'building')))];
}

function insights() {
  const people = state.rows.people || [], companies = state.rows.companies || [], deals = state.rows.deals || [];
  const count = (rows, key) => rows.filter((r) => !!r[key]).length;
  return [heading('Insights', 'Coverage and work completed from local records. No open or reply estimates are invented.'),
    h('div', { class: 'prospect-stats' },
      number('People with email', count(people, 'email'), `of ${people.length} saved people`),
      number('Companies with domain', count(companies, 'domain'), `of ${companies.length} saved companies`),
      number('Deals', deals.length, 'From your pipeline'),
      number('Provider spend', fmtMoney(cache.overview.charged_micros), cache.overview.uncertain_costs
        ? `${cache.overview.uncertain_costs} charge${cache.overview.uncertain_costs === 1 ? '' : 's'} unknown` : 'Capped calls made here')),
    h('div', { class: 'prospect-transfer' }, h('h2', null, 'Cost ledger'),
      cache.costs.length ? h('table', { class: 'prospect-table' },
        h('thead', null, h('tr', null, h('th', null, 'Provider'), h('th', null, 'Action'), h('th', null, 'Outcome'), h('th', null, 'Charged'))),
        h('tbody', null, cache.costs.map((r) => h('tr', null, h('td', null, r.provider), h('td', null, r.action),
          h('td', null, r.outcome), h('td', null, r.outcome === 'charge_unknown' || r.outcome === 'unknown_retry'
            ? 'Unknown, check provider' : fmtMoney(r.charged_micros))))))
        : h('p', { class: 'muted' }, 'No provider calls have been made.'))];
}
