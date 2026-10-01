/**
 * Start-up, login, the shell (sidebar + page + record panel), routing and the global keyboard.
 * Pages are plain functions that fill three regions (top bar, toolbar, content) from the store;
 * any change to the store re-renders the current page on the next animation frame.
 */

import { h, mount, isTyping } from './dom.js';
import { icon } from './icons.js';
import { OBJECTS, RECORD_OBJECTS } from './schema.js';
import { todayISO } from './logic.js';
import { api, setUnauthorizedHandler } from './api.js';
import { state, loadAll, subscribe, applyAppearance, setting } from './store.js';
import { nav } from './nav.js';
import { hasLayer, closePopover } from './ui/overlay.js';
import { openCommandMenu } from './ui/cmdk.js';
import { openCreate } from './ui/create.js';
import { quickTask, openNote, todaysTasks } from './ui/work.js';
import { renderHome } from './pages/home.js';
import { renderList } from './pages/list.js';
import { renderRecordPage, renderPanel } from './pages/record.js';
import { renderTasks, renderNotes } from './pages/work.js';
import { renderSettings, SECTIONS } from './pages/settings.js';
import { renderProspect } from './pages/prospect.js';

const root = document.getElementById('root');
let shell = null; let route = {}; let pageHandle = null; let panelHandle = null; let pending = false;

/* ---------------------------------------------------------------- routing */

function parse() {
  const url = new URL(location.href);
  const parts = url.pathname.split('/').filter(Boolean);
  const query = Object.fromEntries(url.searchParams);
  let r = { page: 'prospect', section: 'overview', query };
  if (parts[0] === 'tasks') r.page = 'tasks';
  else if (parts[0] === 'home') r.page = 'home';
  else if (parts[0] === 'prospect') r = { page: 'prospect', section: parts[1] || 'overview', query };
  else if (parts[0] === 'notes') r.page = 'notes';
  else if (parts[0] === 'settings') r = { page: 'settings', section: parts[1] || 'general', query };
  else if (RECORD_OBJECTS.includes(parts[0])) r = parts[1] ? { page: 'record', object: parts[0], id: Number(parts[1]), query } : { page: 'list', object: parts[0], query };
  if (query.open) {
    const [o, id] = query.open.split(':');
    if (RECORD_OBJECTS.includes(o) && Number(id)) r.open = { object: o, id: Number(id) };
  }
  return r;
}

nav.current = () => route;
nav.go = (path) => {
  closePopover();
  if (location.pathname + location.search !== path) history.pushState(null, '', path);
  shell?.app.classList.remove('side-open');
  render();
  shell?.content.scrollTo?.({ top: 0 });
};
nav.openRecord = (object, id, list) => {
  if (list) state.nav = { object, ids: list };
  else if (!state.nav || state.nav.object !== object || !state.nav.ids.includes(id)) state.nav = null;
  if (setting('record_open', 'panel') === 'page' || route.page === 'record') return nav.go(`/${object}/${id}`);
  const url = new URL(location.href);
  const wasOpen = url.searchParams.has('open');
  url.searchParams.set('open', `${object}:${id}`);
  // Stepping between records replaces history, so Back closes the panel instead of walking through it.
  history[wasOpen ? 'replaceState' : 'pushState'](null, '', url.pathname + url.search);
  render();
};
nav.closeRecord = () => {
  const url = new URL(location.href);
  if (!url.searchParams.has('open')) return;
  url.searchParams.delete('open');
  history.replaceState(null, '', url.pathname + (url.search || ''));
  render();
};
nav.create = (object, defaults = {}) => {
  if (object === 'tasks') return quickTask(defaults.record_type ? { type: defaults.record_type, id: defaults.record_id } : null);
  if (object === 'notes') return openNote(null, defaults.record_type ? { link: { type: defaults.record_type, id: defaults.record_id } } : {});
  openCreate(object, defaults);
};

/* ---------------------------------------------------------------- shell */

function buildShell() {
  const sidebar = h('aside', { class: 'sidebar', 'aria-label': 'Main' });
  const top = h('header', { class: 'topbar' });
  const toolbar = h('div', { class: 'toolbar' });
  const content = h('div', { class: 'content', id: 'content' });
  const main = h('main', { class: 'main' }, top, toolbar, content);
  const app = h('div', { class: 'app' }, sidebar, main);
  try { if (localStorage.getItem('crm.side') === 'hidden') app.classList.add('side-hidden'); } catch {}
  mount(root, app);
  shell = { app, sidebar, top, toolbar, content, main, panel: null };
  main.addEventListener('click', (e) => { if (app.classList.contains('side-open') && !e.target.closest('.menu-btn')) app.classList.remove('side-open'); });
}

function link(path, children, { active, cls = 'nav' } = {}) {
  return h('a', { class: [cls, active && 'active'], href: path, 'aria-current': active ? 'page' : null,
    onClick: (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); nav.go(path); } }, children);
}

function renderSidebar() {
  const s = shell.sidebar;
  const ws = setting('workspace_name', '') || 'Free Apollo';
  const toggle = h('button', { class: 'btn ghost icon sm', 'aria-label': 'Hide sidebar', title: 'Hide sidebar', onClick: () => {
    shell.app.classList.add('side-hidden'); try { localStorage.setItem('crm.side', 'hidden'); } catch {} render();
  } }, icon('sidebar', 15));
  if (route.page === 'settings') {
    mount(s, h('div', { class: 'ws' }, link('/', [icon('arrow-left', 15), 'Back'], { cls: 'nav' })),
      h('div', { class: 'side-label' }, 'Settings'),
      SECTIONS.map(([k, label, ic]) => link('/settings/' + k, [icon(ic, 16), label], { active: route.section === k || (!route.section && k === 'general') })));
    return;
  }
  const due = todaysTasks();
  const overdue = due.some((t) => t.due_date < todayISO());
  mount(s,
    h('div', { class: 'ws' }, h('span', { class: 'ws-logo' }, ws.slice(0, 1).toUpperCase()), h('span', { class: 'ws-name ellipsis grow' }, ws), toggle),
    h('button', { class: 'searchbtn', onClick: openCommandMenu }, icon('search', 15), h('span', { class: 'grow', style: { textAlign: 'left' } }, 'Search'), h('kbd', null, 'Ctrl'), h('kbd', null, 'K')),
    link('/home', [icon('home', 16), 'Home'], { active: route.page === 'home' }),
    link('/', [icon('target', 16), 'Workspace'], { active: route.page === 'prospect' && (!route.section || route.section === 'overview') }),
    h('div', { class: 'side-label' }, 'Prospect and enrich'),
    link('/prospect/discover', [icon('search', 16), 'Find leads'], { active: route.page === 'prospect' && route.section === 'discover' }),
    ['people', 'companies'].map((o) => link('/' + o, [h('span', { class: 'nav-ico', 'data-c': OBJECTS[o].color }, icon(OBJECTS[o].icon, 12, 2)), OBJECTS[o].plural,
      h('span', { class: 'count num' }, (state.rows[o] || []).length)], { active: (route.page === 'list' || route.page === 'record') && route.object === o })),
    link('/prospect/lists', [icon('list', 16), 'Lists'], { active: route.page === 'prospect' && route.section === 'lists' }),
    h('div', { class: 'side-label' }, 'Engage'),
    link('/prospect/draft', [icon('mail', 16), 'Message draft'], { active: route.page === 'prospect' && route.section === 'draft' }),
    link('/prospect/sequences', [icon('list', 16), 'Sequences'], { active: route.page === 'prospect' && route.section === 'sequences' }),
    link('/tasks', [icon('check-square', 16), 'Tasks', due.length ? h('span', { class: ['badge', overdue && 'warn'] }, due.length) : null], { active: route.page === 'tasks' }),
    h('div', { class: 'side-label' }, 'Win deals'),
    link('/deals', [h('span', { class: 'nav-ico', 'data-c': OBJECTS.deals.color }, icon(OBJECTS.deals.icon, 12, 2)), 'Deals',
      h('span', { class: 'count num' }, (state.rows.deals || []).length)], { active: (route.page === 'list' || route.page === 'record') && route.object === 'deals' }),
    h('div', { class: 'side-label' }, 'Tools and insights'),
    link('/prospect/insights', [icon('target', 16), 'Insights'], { active: route.page === 'prospect' && route.section === 'insights' }),
    link('/prospect/transfer', [icon('file-text', 16), 'Import records'], { active: route.page === 'prospect' && route.section === 'transfer' }),
    link('/notes', [icon('file-text', 16), 'Notes'], { active: route.page === 'notes' }),
    h('div', { class: 'side-foot' },
      link('/settings', [icon('sliders', 16), 'Settings'], { active: false }),
      h('button', { class: 'nav', onClick: logout }, icon('logout', 16), 'Log out')));
}

/* ---------------------------------------------------------------- render */

/** Re-rendering while someone types in an unlabelled field would eat their input; wait for blur. */
function shouldDefer() {
  const a = document.activeElement;
  if (!a || !shell) return false;
  const inApp = shell.main.contains(a) || shell.panel?.contains(a) || shell.sidebar.contains(a);
  return inApp && (a.isContentEditable || (['INPUT', 'TEXTAREA'].includes(a.tagName) && !a.id));
}

function render() {
  if (!shell) return;
  if (shouldDefer()) { pending = true; return; }
  pending = false;
  route = parse();
  const focusId = document.activeElement?.id;
  const sel = focusId ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  if (shell.app.classList.contains('side-hidden')) {
    // A floating button brings the sidebar back.
    if (!shell.app.querySelector('.side-show')) shell.main.prepend(h('button', { class: 'btn ghost icon side-show', 'aria-label': 'Show sidebar', title: 'Show sidebar', style: { position: 'absolute', left: '8px', top: '10px', zIndex: 5 },
      onClick: (e) => { shell.app.classList.remove('side-hidden'); e.currentTarget.remove(); try { localStorage.removeItem('crm.side'); } catch {} render(); } }, icon('sidebar', 15)));
    shell.top.style.paddingLeft = '48px';
  } else { shell.app.querySelector('.side-show')?.remove(); shell.top.style.paddingLeft = ''; }
  renderSidebar();
  shell.toolbar.hidden = false;
  const regions = { top: shell.top, toolbar: shell.toolbar, content: shell.content };
  const pages = {
    home: () => renderHome(regions), list: () => renderList(regions, route), record: () => renderRecordPage(regions, route),
    tasks: () => renderTasks(regions), notes: () => renderNotes(regions), settings: () => renderSettings(regions, route),
    prospect: () => renderProspect(regions, route),
  };
  pageHandle = (pages[route.page] || pages.home)() || null;

  if (route.open && route.page !== 'record') {
    if (!shell.panel) { shell.panel = h('aside', { class: 'panel', 'aria-label': 'Record' }); document.body.append(shell.panel); }
    panelHandle = renderPanel(shell.panel, route);
  } else if (shell.panel) { shell.panel.remove(); shell.panel = null; panelHandle = null; }

  const title = route.page === 'list' || route.page === 'record' ? OBJECTS[route.object].plural : route.page === 'home' ? 'Home' : route.page[0].toUpperCase() + route.page.slice(1);
  document.title = `${title} · ${setting('workspace_name', '') || 'Free Apollo'}`;
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el && document.activeElement !== el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(...sel); } catch {} }
  }
}

document.addEventListener('focusout', () => { if (pending) setTimeout(() => { if (pending && !shouldDefer()) render(); }); });
window.addEventListener('popstate', () => { closePopover(); render(); });

/* ---------------------------------------------------------------- keyboard */

let gPending = false; let gTimer = null;
document.addEventListener('keydown', (e) => {
  if (!shell) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCommandMenu(); return; }
  if (hasLayer() || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (gPending) {
    gPending = false; clearTimeout(gTimer);
    const to = { h: '/', p: '/people', c: '/companies', d: '/deals', t: '/tasks', n: '/notes', s: '/settings' }[k];
    if (to) { e.preventDefault(); nav.go(to); }
    return;
  }
  if (k === 'g') { gPending = true; gTimer = setTimeout(() => { gPending = false; }, 1200); return; }
  if (e.key === 'Escape' && route.open) { e.preventDefault(); nav.closeRecord(); return; }
  if (route.open && panelHandle?.onKey?.(e)) { e.preventDefault(); return; }
  if (pageHandle?.onKey?.(e)) { e.preventDefault(); return; }
  if (e.key === '?') { e.preventDefault(); nav.go('/settings/shortcuts'); return; }
  if (k === 'c' && (route.page === 'list' || route.page === 'record')) { e.preventDefault(); nav.create(route.object); return; }
  if (k === 'd') { e.preventDefault(); nav.create('deals'); return; }
  if (k === 't') { e.preventDefault(); quickTask(null); return; }
  if (k === 'n') { e.preventDefault(); openNote(null); return; }
});

/* ---------------------------------------------------------------- login and boot */

async function logout() {
  await api.post('/logout').catch(() => {});
  shell = null;
  renderLogin();
}

function renderLogin(message) {
  shell = null;
  document.querySelector('.panel')?.remove();
  const input = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Password', 'aria-label': 'Password', id: 'pw' });
  const err = h('div', { class: 'field-error', role: 'alert', hidden: !message }, message || '');
  const btn = h('button', { class: 'btn primary', type: 'submit', style: { height: '34px' } }, 'Continue');
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true; err.hidden = true;
    try { await api.post('/login', { password: input.value }); await boot(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; input.select(); }
  } }, input, err, btn);
  mount(root, h('div', { class: 'login' }, h('div', { class: 'login-card' },
    h('span', { class: 'ws-logo' }, 'A'),
    h('div', null, h('h1', null, 'Sign in'), h('p', null, 'Enter the password you set with ', h('code', null, 'wrangler secret put'), '.')),
    form,
    h('div', { class: 'login-foot' }, 'Your prospecting workspace, on your own Cloudflare account.'))));
  requestAnimationFrame(() => input.focus());
}

function renderProblem(title, text) {
  mount(root, h('div', { class: 'login' }, h('div', { class: 'login-card' }, h('h1', null, title), h('p', null, text))));
}

async function boot() {
  try { await api.get('/me'); }
  catch (e) {
    if (e.status === 401) return renderLogin();
    return renderProblem('Setup is not finished', e.message);
  }
  mount(root, h('div', { class: 'login' }, h('div', { class: 'stack', style: { width: '200px' } }, [1, 2, 3].map((i) => h('div', { class: 'skel', style: { width: 100 - i * 20 + '%' } })))));
  try { await loadAll(); }
  catch (e) { return renderProblem('Could not load your data', e.message + (/no such table/i.test(e.message) ? ' Run: npx wrangler d1 execute free-apollo --remote --file schema.sql' : '')); }
  buildShell();
  render();
}

setUnauthorizedHandler(() => { if (shell) renderLogin('Your session ended. Sign in again.'); });
subscribe(render);
applyAppearance();
boot();
