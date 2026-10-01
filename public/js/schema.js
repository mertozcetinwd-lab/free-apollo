/**
 * The data model, shared by the browser and the Worker (the Worker imports this file too), so the
 * rules for what a valid value is live in exactly one place.
 *
 * Every object uses the same engine: a list of typed fields. The table, the board, the record
 * panel, filters and CSV import all read these definitions instead of knowing about People or
 * Deals. Custom fields added in Settings are appended at runtime with the same shape.
 */

export const OBJECTS = {
  people: {
    key: 'people', singular: 'Person', plural: 'People', icon: 'user', color: 'blue', primary: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'phone', label: 'Phone', type: 'phone' },
      { key: 'title', label: 'Job title', type: 'text' },
      { key: 'company_id', label: 'Company', type: 'relation', to: 'companies' },
      { key: 'city', label: 'City', type: 'text' },
      { key: 'linkedin', label: 'LinkedIn', type: 'url' },
      { key: 'source', label: 'Source', type: 'text' },
      { key: 'tags', label: 'Tags', type: 'tags' },
      { key: 'created_at', label: 'Created', type: 'timestamp', readonly: true },
      { key: 'updated_at', label: 'Last updated', type: 'timestamp', readonly: true },
    ],
  },
  companies: {
    key: 'companies', singular: 'Company', plural: 'Companies', icon: 'building', color: 'violet', primary: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'domain', label: 'Domain', type: 'domain' },
      { key: 'industry', label: 'Industry', type: 'text' },
      { key: 'employees', label: 'Employees', type: 'number' },
      { key: 'phone', label: 'Phone', type: 'phone' },
      { key: 'city', label: 'City', type: 'text' },
      { key: 'tags', label: 'Tags', type: 'tags' },
      { key: 'created_at', label: 'Created', type: 'timestamp', readonly: true },
      { key: 'updated_at', label: 'Last updated', type: 'timestamp', readonly: true },
    ],
  },
  deals: {
    key: 'deals', singular: 'Deal', plural: 'Deals', icon: 'target', color: 'amber', primary: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'value_cents', label: 'Value', type: 'currency' },
      { key: 'stage', label: 'Stage', type: 'stage' },
      { key: 'company_id', label: 'Company', type: 'relation', to: 'companies' },
      { key: 'person_id', label: 'Contact', type: 'relation', to: 'people' },
      { key: 'close_date', label: 'Expected close', type: 'date' },
      { key: 'source', label: 'Source', type: 'text' },
      { key: 'lost_reason', label: 'Lost reason', type: 'text' },
      { key: 'stage_changed_at', label: 'In stage since', type: 'timestamp', readonly: true },
      { key: 'created_at', label: 'Created', type: 'timestamp', readonly: true },
      { key: 'updated_at', label: 'Last updated', type: 'timestamp', readonly: true },
    ],
  },
  tasks: {
    key: 'tasks', singular: 'Task', plural: 'Tasks', icon: 'check-square', color: 'green', primary: 'title',
    fields: [
      { key: 'title', label: 'Task', type: 'text', required: true },
      { key: 'due_date', label: 'Due', type: 'date' },
      { key: 'done', label: 'Done', type: 'checkbox' },
      { key: 'record_type', label: 'Linked to', type: 'recordtype' },
      { key: 'record_id', label: 'Record', type: 'recordid' },
      { key: 'created_at', label: 'Created', type: 'timestamp', readonly: true },
    ],
  },
  notes: {
    key: 'notes', singular: 'Note', plural: 'Notes', icon: 'file-text', color: 'teal', primary: 'title',
    fields: [
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'body', label: 'Body', type: 'longtext' },
      { key: 'record_type', label: 'Linked to', type: 'recordtype' },
      { key: 'record_id', label: 'Record', type: 'recordid' },
      { key: 'created_at', label: 'Created', type: 'timestamp', readonly: true },
      { key: 'updated_at', label: 'Last updated', type: 'timestamp', readonly: true },
    ],
  },
};

/** Objects that have their own pages, views and custom fields. Tasks and notes hang off these. */
export const RECORD_OBJECTS = ['people', 'companies', 'deals'];
export const ALL_OBJECTS = Object.keys(OBJECTS);

/** Types a user can pick for a custom field in Settings > Fields. */
export const CUSTOM_TYPES = [
  { type: 'text', label: 'Text' }, { type: 'number', label: 'Number' }, { type: 'currency', label: 'Currency' },
  { type: 'date', label: 'Date' }, { type: 'select', label: 'Select' }, { type: 'checkbox', label: 'Checkbox' },
  { type: 'url', label: 'Link' }, { type: 'email', label: 'Email' }, { type: 'phone', label: 'Phone' },
];

/** Stage and select colours. The CSS maps each name to a light and a dark tint. */
export const COLORS = ['gray', 'blue', 'violet', 'green', 'amber', 'red', 'pink', 'teal'];
export const STAGE_KINDS = ['open', 'won', 'lost'];

/** Field list for an object, with the custom fields from the database appended (in order). */
export function fieldsFor(object, customFields = []) {
  const base = OBJECTS[object]?.fields || [];
  const custom = customFields.filter((f) => f.object === object)
    .sort((a, b) => a.position - b.position)
    .map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options || [], custom: true, id: f.id }));
  return [...base, ...custom];
}

const ok = (value) => ({ ok: true, value });
const bad = (error) => ({ ok: false, error });

/**
 * Validate and normalise one value for one field. Returns {ok, value} or {ok:false, error}.
 * The Worker runs this on every write; the browser runs it before sending, so a bad value is
 * caught at the input instead of after a round trip.
 */
export function cleanValue(field, raw) {
  const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
  if (empty) {
    if (field.required) return bad(`${field.label} is required`);
    return ok(field.type === 'checkbox' ? false : null);
  }
  const s = typeof raw === 'string' ? raw.trim() : raw;
  switch (field.type) {
    case 'text': case 'recordtype':
      return ok(String(s).slice(0, 500));
    case 'longtext':
      return ok(String(raw).slice(0, 50000));
    case 'email':
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s)) ? ok(String(s).toLowerCase().slice(0, 320)) : bad('That email looks wrong');
    case 'phone':
      return /^[+()\d\s.\-x]{3,40}$/i.test(String(s)) ? ok(String(s)) : bad('That phone number looks wrong');
    case 'url': {
      const u = String(s);
      if (!/^(https?:\/\/)?[^\s/]+\.[^\s]+$/i.test(u)) return bad('That link looks wrong');
      return ok((/^https?:\/\//i.test(u) ? u : 'https://' + u).slice(0, 500));
    }
    case 'domain': {
      const d = String(s).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
      return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? ok(d) : bad('That domain looks wrong');
    }
    case 'number': {
      const n = Number(String(s).replace(/,/g, ''));
      return Number.isFinite(n) ? ok(n) : bad(`${field.label} must be a number`);
    }
    case 'currency': {
      // Stored as integer cents: floats and money do not mix.
      const n = Math.round(Number(s));
      return Number.isFinite(n) && n >= 0 ? ok(n) : bad(`${field.label} must be a positive amount`);
    }
    case 'date': {
      const d = String(s).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d + 'T00:00:00Z'))) return bad('Dates are YYYY-MM-DD');
      return ok(d);
    }
    case 'select': {
      const values = (field.options || []).map((o) => o.value);
      return values.includes(String(s)) ? ok(String(s)) : bad(`"${s}" is not an option for ${field.label}`);
    }
    case 'checkbox':
      return ok(raw === true || raw === 1 || raw === '1' || raw === 'true' || raw === 'yes');
    case 'tags': {
      const list = (Array.isArray(raw) ? raw : String(raw).split(','))
        .map((t) => String(t).trim()).filter(Boolean).slice(0, 30).map((t) => t.slice(0, 40));
      return ok(list.length ? [...new Set(list)].join(', ') : null);
    }
    case 'relation': case 'recordid': {
      const n = Number(s);
      return Number.isInteger(n) && n > 0 ? ok(n) : bad(`${field.label} must point at a record`);
    }
    case 'stage':
      return ok(String(s).slice(0, 60));
    default:
      return bad(`${field.label} cannot be set`);
  }
}

/**
 * Clean a whole payload for an object. Unknown keys and read-only fields are dropped.
 * partial=true (PATCH) only checks the keys that were sent.
 */
export function cleanRecord(object, input, { partial = false, customFields = [] } = {}) {
  const fields = fieldsFor(object, customFields);
  const out = {}; const extra = {};
  for (const f of fields) {
    if (f.readonly) continue;
    if (!(f.key in (input || {}))) {
      if (!partial && f.required) return bad(`${f.label} is required`);
      continue;
    }
    const c = cleanValue(f, input[f.key]);
    if (!c.ok) return c;
    if (f.custom) extra[f.key] = c.value; else out[f.key] = c.value;
  }
  return { ok: true, row: out, extra };
}
