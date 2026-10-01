import { h } from '../dom.js';
import { api } from '../api.js';
import { state, reload } from '../store.js';
import { nav } from '../nav.js';
import { toast } from '../ui/overlay.js';
import { LOCAL_CATEGORIES, checkArea, runOverpass } from '../overpass.js';

const last = { company: null, local: null, people: null, site: null, siteInput: {}, busy: false, status: '', recent: null };
const redraw = () => { if (nav.current().page === 'prospect') nav.go(location.pathname); };
const button = (label, onClick, className = 'btn') => h('button', { class: className, type: 'button', onClick }, label);
const field = (name, placeholder = '', value = '') => h('input', { class: 'input', name, placeholder, value, 'aria-label': name.replaceAll('_', ' ') });
const money = (micros) => '$' + (micros / 1e6).toFixed(3);

async function runCompany(form) {
  if (last.busy) return;
  last.busy = true; last.status = 'Searching public company records…'; redraw();
  try {
    const payload = Object.fromEntries(new FormData(form));
    last.company = await api.post('/prospect/search/companies', payload);
    last.status = `${last.company.results.length} company results. Review each source before saving.`;
    loadRecent();
  } catch (e) { last.status = `Search failed: ${e.message}`; }
  last.busy = false; redraw();
}

async function runLocal(form) {
  if (last.busy) return;
  const input = Object.fromEntries(new FormData(form));
  last.busy = true; last.status = 'Finding the place, then searching public map records…'; redraw();
  try {
    const place = await api.post('/prospect/search/place', { place: input.place });
    const area = { lat: place.lat, lon: place.lon, radius_m: Number(input.radius_m), category: input.category };
    const elements = await runOverpass(checkArea(area));
    last.local = await api.post('/prospect/search/local', { ...area, elements });
    last.status = `${last.local.results.length} local businesses near ${place.name}. Map details need review.`;
    loadRecent();
  } catch (e) { last.status = `Local search stopped: ${e.message}`; }
  last.busy = false; redraw();
}

async function runPeople(form) {
  if (last.busy) return;
  const input = Object.fromEntries(new FormData(form));
  if (!form.querySelector('[name="approved"]').checked) return toast('Review the $0.100 maximum and confirm the paid search.', { error: true });
  last.busy = true; last.status = 'Searching the optional people provider…'; redraw();
  try {
    last.people = await api.post('/prospect/search/people', {
      title: input.title, company_domain: input.company_domain, location: input.location,
      limit: 10, max_micros: 100000, approved: true,
    });
    last.status = `${last.people.results.length} people results. Actual provider charge: ${money(last.people.cost_micros)}.`;
    loadRecent();
  } catch (e) { last.status = `People search stopped: ${e.message}`; }
  last.busy = false; redraw();
}

async function runSite(form) {
  if (last.busy) return;
  const input = Object.fromEntries(new FormData(form));
  last.siteInput = input;
  last.busy = true; last.status = 'Reading the chosen company page…'; redraw();
  try {
    last.site = await api.post('/prospect/search/company-site', { company_id: Number(input.company_id),
      url: input.url, name: input.name, title: input.title });
    last.status = `${last.site.results.length} owner or founder candidates found on the chosen page. Review the page before saving. No email was verified.`;
    loadRecent();
  } catch (e) { last.status = `Company page search stopped: ${e.message}`; }
  last.busy = false; redraw();
}

async function saveSelected(search, table) {
  const selected = [...table.querySelectorAll('input[type="checkbox"]:checked')].map((el) => Number(el.value));
  if (!selected.length) return toast('Select at least one result.');
  const total = { added: 0, existing: 0 };
  try {
    const batch = search.kind === 'people' ? 3 : 5;
    for (let i = 0; i < selected.length; i += batch) {
      const result = await api.post('/prospect/search/save', { search_id: search.id, indices: selected.slice(i, i + batch) });
      total.added += result.added; total.existing += result.existing;
    }
    await reload(search.kind);
    last.status = `${total.added} saved, ${total.existing} already saved. Source evidence is attached to each record.`;
    toast(last.status); redraw();
  } catch (e) { last.status = `Save stopped: ${e.message}. Already saved rows remain in your records.`; redraw(); }
}

function resultTable(search) {
  if (!search) return h('p', { class: 'muted' }, 'Run a search to see results.');
  const rows = search.results || [];
  if (!rows.length) return h('p', { class: 'muted' }, 'No matching rows in this result. That does not prove there are no matches elsewhere.');
  const table = h('div', { class: 'discovery-results' },
    h('div', { class: 'row' }, h('span', { class: 'prospect-pill' }, search.source),
      h('span', { class: 'muted' }, search.cached ? 'Cached, no new charge' : `Observed ${new Date(search.observed_at).toLocaleDateString()}`),
      h('span', { class: 'grow' }), button('Save selected', () => saveSelected(search, table), 'btn primary')),
    h('table', { class: 'prospect-table' }, h('thead', null, h('tr', null,
      h('th', null, 'Save'), h('th', null, 'Name'), h('th', null, search.kind === 'people' ? 'Job title' : 'Industry'),
      h('th', null, 'Company domain'), h('th', null, 'Source'))),
      h('tbody', null, rows.map((r, index) => h('tr', null,
        h('td', null, h('input', { type: 'checkbox', value: index, 'aria-label': `Save ${r.name}` })),
        h('td', null, r.name), h('td', null, search.kind === 'people' ? r.title || 'Unknown' : r.industry || 'Unknown'),
        h('td', null, r.domain || 'Unknown'), h('td', null, r.source_url ? h('a', { href: r.source_url, target: '_blank', rel: 'noopener noreferrer' }, 'Open source') : search.source))))));
  return table;
}

async function enrich(form) {
  if (last.busy) return;
  const input = Object.fromEntries(new FormData(form));
  if (!form.querySelector('[name="approved"]').checked) return toast('Confirm the displayed provider maximum first.', { error: true });
  const cap = input.action === 'email_find' ? 20000 : 10000;
  last.busy = true;
  last.status = 'Running capped provider call…'; redraw();
  try {
    const result = await api.post('/prospect/enrich/person', { person_id: Number(input.person_id),
      action: input.action, domain: input.domain, max_micros: cap, approved: true });
    last.status = `Result: ${result.state}. Actual charge: ${money(result.charged_micros)}. Review the record evidence.`;
  } catch (e) { last.status = `Provider call stopped: ${e.message}`; }
  last.busy = false;
  redraw();
}

async function loadRecent() {
  try { last.recent = await api.get('/prospect/searches'); } catch { last.recent = []; }
  redraw();
}

async function openRecent(item) {
  try {
    const search = await api.get(`/prospect/search/${item.id}`);
    if (search.source === 'company_site') last.site = search;
    else if (search.kind === 'people') last.people = search;
    else if (search.source === 'osm_local') last.local = search;
    else last.company = search;
    last.status = `Opened ${search.results.length} saved ${search.kind} results. No new provider charge.`;
    redraw();
  } catch (e) { toast(e.message, { error: true }); }
}

export function discover() {
  if (last.recent === null) queueMicrotask(loadRecent);
  const people = state.rows.people || [];
  const companies = state.rows.companies || [];
  const companyForm = h('form', { class: 'discovery-form', onSubmit: (e) => { e.preventDefault(); runCompany(e.currentTarget); } },
    h('label', null, 'Industry', field('industry', 'Example: software')),
    h('label', null, 'US state, optional', field('state', 'FL')),
    button('Find companies', () => runCompany(companyForm), 'btn primary'));
  const localForm = h('form', { class: 'discovery-form', onSubmit: (e) => { e.preventDefault(); runLocal(e.currentTarget); } },
    h('label', null, 'City and state', field('place', 'Gainesville, FL')),
    h('label', null, 'Business type', h('select', { class: 'input', name: 'category' },
      Object.entries(LOCAL_CATEGORIES).map(([value, row]) => h('option', { value }, row[0])))),
    h('label', null, 'Radius', h('select', { class: 'input', name: 'radius_m' },
      [[5000, '5 km'], [10000, '10 km'], [25000, '25 km']].map(([value, label]) => h('option', { value }, label)))),
    button('Find local businesses', () => runLocal(localForm), 'btn primary'));
  const peopleForm = h('form', { class: 'discovery-form', onSubmit: (e) => { e.preventDefault(); runPeople(e.currentTarget); } },
    h('label', null, 'Job title', field('title', 'Example: owner')),
    h('label', null, 'Company domain', field('company_domain', 'example.com')),
    h('label', null, 'Location, optional', field('location', 'Florida')),
    h('label', { class: 'discovery-check' }, h('input', { type: 'checkbox', name: 'approved' }),
      'I approve a provider search with a maximum charge of $0.100. The actual charge is logged.'),
    button('Find people', () => runPeople(peopleForm), 'btn primary'));
  const siteForm = h('form', { class: 'discovery-form', onSubmit: (e) => { e.preventDefault(); runSite(e.currentTarget); } },
    h('label', null, 'Saved company', h('select', { class: 'input', name: 'company_id' },
      companies.map((c) => h('option', { value: c.id, selected: String(c.id) === last.siteInput.company_id }, c.name)))),
    h('label', null, 'Official team or about page', field('url', 'https://example.com/about/', last.siteInput.url || '')),
    h('label', null, 'Name seen on page, optional', field('name', 'Full name', last.siteInput.name || '')),
    h('label', null, 'Role seen near name, optional', field('title', 'Owner', last.siteInput.title || '')),
    button('Find named leaders', () => runSite(siteForm), 'btn primary'));
  const action = h('select', { class: 'input', name: 'action', 'aria-label': 'Enrichment action' },
    h('option', { value: 'email_find' }, 'Find work email, up to $0.020'),
    h('option', { value: 'email_verify' }, 'Verify work email, up to $0.010'));
  const enrichForm = h('form', { class: 'discovery-form', onSubmit: (e) => { e.preventDefault(); enrich(e.currentTarget); } },
    h('label', null, 'Saved person', h('select', { class: 'input', name: 'person_id' },
      people.map((p) => h('option', { value: p.id }, p.name)))),
    h('label', null, 'Company domain for email finding', field('domain', 'example.com')),
    h('label', null, 'Action', action),
    h('label', { class: 'discovery-check' }, h('input', { type: 'checkbox', name: 'approved' }),
      'I approve the displayed maximum. No email is sent.'),
    button('Run selected action', () => enrich(enrichForm), 'btn primary'));
  return [h('div', { class: 'prospect-heading' }, h('div', null, h('h1', null, 'Find and enrich'),
      h('p', null, 'Find public companies and local businesses, check leaders on company websites, or use your own capped people provider.'))),
    h('p', { role: 'status', class: 'prospect-import-status' }, last.status || 'No search run this session.'),
    h('div', { class: 'discovery-grid' },
      h('section', { class: 'prospect-transfer' }, h('h2', null, 'Local businesses · free public data'),
        h('p', null, 'OpenStreetMap results can be incomplete. The public search servers may be busy. Attribution: © OpenStreetMap contributors, ODbL.'),
        localForm, resultTable(last.local)),
      h('section', { class: 'prospect-transfer' }, h('h2', null, 'Companies · free public data'),
        h('p', null, 'Wikidata is uneven. A missing field stays unknown.'), companyForm, resultTable(last.company)),
      h('section', { class: 'prospect-transfer' }, h('h2', null, 'Company website · free'),
        h('p', null, 'Read one page on a saved company domain. Structured leader entries become candidates. If the page uses ordinary prose, enter a full name and nearby role to check them against that page. Review candidates before saving.'),
        companies.length ? siteForm : h('p', { class: 'muted' }, 'Save a company with a website domain first.'), resultTable(last.site)),
      h('section', { class: 'prospect-transfer' }, h('h2', null, 'People · your provider key'),
        h('p', null, 'Search by title and company. Requires TREG_TOKEN. No search runs until you approve its cap.'), peopleForm, resultTable(last.people))),
    h('section', { class: 'prospect-transfer' }, h('h2', null, 'Contact enrichment'),
      h('p', null, 'Find or verify a saved person’s work email. A found email stays unverified until a verifier returns a valid verdict.'),
      people.length ? enrichForm : h('p', { class: 'muted' }, 'Save a person first.')),
    h('section', { class: 'prospect-transfer' }, h('h2', null, 'Recent searches'),
      last.recent?.length ? last.recent.map((item) => h('div', { class: 'row discovery-recent' },
        h('strong', null, item.kind), h('span', null, item.source),
        h('span', { class: 'muted' }, `${item.count} results · ${new Date(item.observed_at).toLocaleDateString()}`),
        h('span', { class: 'grow' }), button('Open', () => openRecent(item))))
        : h('p', { class: 'muted' }, 'No searches yet.'))];
}
