/** CSV import dialog: drop or choose a file, send it, show what was added and what was skipped. */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { OBJECTS } from '../schema.js';
import { api } from '../api.js';
import { reload } from '../store.js';
import { modal, toast } from './overlay.js';

const HINT = {
  people: 'Columns like Name (or First Name + Last Name), Email, Phone, Job Title, Company, Tags, Notes.',
  companies: 'Columns like Name, Domain or Website, Industry, Employees, Phone, City, Tags.',
  deals: 'Columns like Deal Name, Amount, Stage, Company, Contact, Close Date.',
};

export function openImport(object) {
  const def = OBJECTS[object];
  modal({
    title: `Import ${def.plural.toLowerCase()} from CSV`, width: 520,
    body: (b, m) => {
      const status = h('div');
      const file = h('input', { type: 'file', accept: '.csv,text/csv', class: 'sr-only', id: 'csvfile' });
      const drop = h('label', {
        for: 'csvfile', class: 'empty', style: { padding: '28px 16px', borderRadius: 'var(--r-lg)', boxShadow: 'inset 0 0 0 1.5px var(--line-2)', cursor: 'pointer' },
      }, h('div', { class: 'art' }, h('div', { class: 'tile', style: { width: '40px', height: '40px' } }, icon('upload', 18))),
      h('h2', null, 'Drop a CSV here, or click to choose one'),
      h('p', null, HINT[object] + ' Exports from HubSpot, Pipedrive and Google Contacts work as they are.'));
      const send = async (f) => {
        if (!f) return;
        mount(status, h('div', { class: 'row muted' }, h('div', { class: 'skel', style: { width: '120px' } }), 'Importing…'));
        try {
          const r = await api.post(`/import/${object}`, await f.text());
          await reload(object);
          if (object !== 'companies' && r.companiesCreated) await reload('companies');
          await reload('notes');
          mount(status, h('div', { class: 'stack' },
            h('div', { class: 'row' }, icon('check-circle', 16), h('b', null, `Added ${r.added}`), r.skipped ? h('span', { class: 'muted' }, `· skipped ${r.skipped}`) : null,
              r.companiesCreated ? h('span', { class: 'muted' }, `· created ${r.companiesCreated} companies`) : null),
            r.truncated ? h('div', { class: 'muted' }, 'Only the first 5,000 rows were read.') : null,
            r.errors?.length ? h('div', { class: 'faint' }, r.errors.map((e) => h('div', null, e))) : null));
          toast(`Imported ${r.added} ${r.added === 1 ? def.singular.toLowerCase() : def.plural.toLowerCase()}`);
        } catch (e) {
          mount(status, h('div', { class: 'field-error' }, e.message));
        }
      };
      file.addEventListener('change', () => send(file.files[0]));
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.style.boxShadow = 'inset 0 0 0 1.5px var(--accent)'; });
      drop.addEventListener('dragleave', () => { drop.style.boxShadow = 'inset 0 0 0 1.5px var(--line-2)'; });
      drop.addEventListener('drop', (e) => { e.preventDefault(); drop.style.boxShadow = 'inset 0 0 0 1.5px var(--line-2)'; send(e.dataTransfer.files[0]); });
      b.append(file, drop, status);
    },
    footer: (f, m) => f.append(h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: m.close }, 'Done')),
    initialFocus: false,
  });
}

export function exportCsv(object) {
  const a = h('a', { href: `/api/export/${object}.csv`, download: '' });
  document.body.append(a); a.click(); a.remove();
}
