/**
 * Pure functions behind the views: formatting, filtering, sorting, column calculations and the
 * deal timeline. No DOM here, so node:test can prove each one (test/logic.test.mjs).
 *
 * Filtering and sorting run in the browser on purpose: a CRM for one person or a small team holds
 * thousands of rows, not millions, and client-side filtering answers instantly on every keystroke.
 */

/* ---------------------------------------------------------------- formatting */

export function fmtMoney(cents, currency = 'USD', { compact = false } = {}) {
  if (cents === null || cents === undefined || cents === '') return '';
  const n = Number(cents) / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency,
      notation: compact ? 'compact' : 'standard',
      maximumFractionDigits: compact ? 1 : (Number.isInteger(n) ? 0 : 2),
    }).format(n);
  } catch {
    return '$' + n.toLocaleString('en-US');
  }
}

export function fmtNumber(n) {
  if (n === null || n === undefined || n === '') return '';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 25, 2026" (default), "25 Sep 2026" (dmy) or "2026-09-25" (iso). Dates stay in their own day. */
export function fmtDate(d, format = 'mdy') {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  if (!y || !m || !day) return String(d);
  if (format === 'iso') return String(d).slice(0, 10);
  if (format === 'dmy') return `${day} ${MONTHS[m - 1]} ${y}`;
  return `${MONTHS[m - 1]} ${day}, ${y}`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function relTime(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return fmtDate(iso);
}

export function todayISO(now = new Date()) {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}

/** The local calendar day of a UTC timestamp ("2026-09-26T01:30Z" is still Sep 25 in Florida). */
export function localDate(iso) {
  return iso ? todayISO(new Date(iso)) : '';
}

export function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toMs = Date.now()) {
  if (!fromIso) return 0;
  return Math.max(0, Math.floor((toMs - Date.parse(fromIso)) / 86400000));
}

/** Where a due date falls relative to today: overdue, today, upcoming, or none. */
export function dueBucket(date, today) {
  if (!date) return 'none';
  if (date < today) return 'overdue';
  if (date === today) return 'today';
  return 'upcoming';
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** A stable colour per name, so an avatar keeps its colour across sessions. */
export function hueFor(text) {
  let h = 0;
  for (const c of String(text || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ['blue', 'violet', 'green', 'amber', 'red', 'pink', 'teal'][h % 7];
}

/* ---------------------------------------------------------------- values */

/** The raw value of a field on a row (custom fields live in row.extra). */
export function rawValue(row, field) {
  if (!row) return null;
  if (field.custom) return row.extra ? row.extra[field.key] ?? null : null;
  if (field.key === 'done') return !!row.done_at;
  return row[field.key] ?? null;
}

/**
 * The text a person would see for a value. Filters and search match against this, so searching
 * "acme" finds a deal whose company is Acme even though the deal stores company_id = 7.
 */
export function displayValue(row, field, ctx = {}) {
  const v = rawValue(row, field);
  if (v === null || v === undefined || v === '') return '';
  switch (field.type) {
    case 'currency': return fmtMoney(v, ctx.currency);
    case 'number': return fmtNumber(v);
    case 'date': return fmtDate(v, ctx.dateFormat);
    case 'timestamp': return fmtDate(localDate(v), ctx.dateFormat);
    case 'checkbox': return v ? 'Yes' : 'No';
    case 'relation': {
      const map = ctx[field.to];
      const r = map && map.get(Number(v));
      return r ? r.name : '';
    }
    case 'stage': return ctx.stages?.get(v)?.name || v;
    case 'select': return (field.options || []).find((o) => o.value === v)?.value || v;
    default: return String(v);
  }
}

/* ---------------------------------------------------------------- filters */

/** Operators offered per field type. The filter chip shows these labels. */
export const OPERATORS = {
  text: [['contains', 'contains'], ['not_contains', 'does not contain'], ['is', 'is'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  number: [['eq', '='], ['gt', '>'], ['lt', '<'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  date: [['before', 'is before'], ['after', 'is after'], ['is', 'is'], ['overdue', 'is overdue'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  choice: [['is', 'is'], ['is_not', 'is not'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  checkbox: [['checked', 'is checked'], ['unchecked', 'is not checked']],
};

export function operatorGroup(type) {
  if (['number', 'currency'].includes(type)) return 'number';
  if (['date', 'timestamp'].includes(type)) return 'date';
  if (['stage', 'select', 'relation'].includes(type)) return 'choice';
  if (type === 'checkbox') return 'checkbox';
  return 'text';
}

export const NO_VALUE_OPS = ['empty', 'not_empty', 'overdue', 'checked', 'unchecked'];

export function matchFilter(row, filter, field, ctx = {}) {
  const raw = rawValue(row, field);
  const isEmpty = raw === null || raw === undefined || raw === '';
  const { op } = filter;
  if (op === 'empty') return isEmpty;
  if (op === 'not_empty') return !isEmpty;
  if (op === 'checked') return !!raw;
  if (op === 'unchecked') return !raw;
  if (op === 'overdue') return !isEmpty && String(raw).slice(0, 10) < (ctx.today || todayISO());
  const group = operatorGroup(field.type);
  const val = filter.value;
  if (val === undefined || val === null || val === '') return true; // an unfinished chip filters nothing
  if (group === 'number') {
    if (isEmpty) return false;
    const want = field.type === 'currency' ? Math.round(Number(val) * 100) : Number(val);
    const have = Number(raw);
    return op === 'eq' ? have === want : op === 'gt' ? have > want : op === 'lt' ? have < want : true;
  }
  if (group === 'date') {
    if (isEmpty) return false;
    const have = String(raw).slice(0, 10);
    return op === 'before' ? have < val : op === 'after' ? have > val : have === val;
  }
  if (group === 'choice') {
    const have = isEmpty ? '' : String(raw);
    return op === 'is' ? have === String(val) : op === 'is_not' ? have !== String(val) : true;
  }
  const text = displayValue(row, field, ctx).toLowerCase();
  const needle = String(val).toLowerCase();
  if (op === 'contains') return text.includes(needle);
  if (op === 'not_contains') return !text.includes(needle);
  if (op === 'is') return text === needle;
  return true;
}

export function applyFilters(rows, filters = [], fields = [], ctx = {}) {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const active = filters.filter((f) => byKey.has(f.field));
  if (!active.length) return rows;
  return rows.filter((r) => active.every((f) => matchFilter(r, f, byKey.get(f.field), ctx)));
}

/** Quick search across every visible text value of a row. */
export function searchRows(rows, q, fields, ctx = {}) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return rows;
  const searchable = fields.filter((f) => !['timestamp', 'checkbox'].includes(f.type));
  return rows.filter((r) => searchable.some((f) => displayValue(r, f, ctx).toLowerCase().includes(needle)));
}

/* ---------------------------------------------------------------- sorting */

export function sortRows(rows, sort, fields, ctx = {}) {
  if (!sort || !sort.field) return rows;
  const field = fields.find((f) => f.key === sort.field);
  if (!field) return rows;
  const dir = sort.dir === 'desc' ? -1 : 1;
  const numeric = ['number', 'currency', 'checkbox'].includes(field.type);
  const key = (r) => {
    if (field.type === 'stage') return ctx.stages?.get(r.stage)?.position ?? 999;
    if (numeric) { const v = rawValue(r, field); return v === null ? null : Number(v); }
    const v = ['relation', 'select'].includes(field.type) ? displayValue(r, field, ctx) : rawValue(r, field);
    return v === null || v === '' ? null : String(v).toLowerCase();
  };
  // Empty values always sink to the bottom, whichever way the column is sorted.
  return [...rows].sort((a, b) => {
    const x = key(a); const y = key(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

/* ---------------------------------------------------------------- calculations */

export const CALCS = {
  count: 'Count', filled: 'Count filled', empty: 'Count empty', percent_filled: 'Percent filled',
  sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max',
};

export function calcsFor(type) {
  const base = ['count', 'filled', 'empty', 'percent_filled'];
  return ['number', 'currency'].includes(type) ? [...base, 'sum', 'avg', 'min', 'max'] : base;
}

/** Column footer value. Returns a number (or null); the view formats it with the column's type. */
export function calc(rows, field, fn) {
  const vals = rows.map((r) => rawValue(r, field));
  const filled = vals.filter((v) => v !== null && v !== undefined && v !== '' && v !== false);
  const nums = filled.map(Number).filter(Number.isFinite);
  switch (fn) {
    case 'count': return rows.length;
    case 'filled': return filled.length;
    case 'empty': return rows.length - filled.length;
    case 'percent_filled': return rows.length ? Math.round((filled.length / rows.length) * 100) : 0;
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
    case 'min': return nums.length ? Math.min(...nums) : null;
    case 'max': return nums.length ? Math.max(...nums) : null;
    default: return null;
  }
}

/* ---------------------------------------------------------------- deals */

/**
 * Days a deal spent in each stage, from its creation time and its stage-change activity.
 * Returns one entry per stage in pipeline order: {key, name, days, state: done|current|future}.
 * A stage the deal skipped shows state "done" with 0 days only if a later stage was reached.
 */
export function stageTimeline(deal, events, stages, now = Date.now()) {
  const moves = (events || []).filter((e) => e.kind === 'stage')
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const spent = new Map();
  let current = moves.length ? moves[0].data.from : deal.stage;
  const visited = new Set([current, deal.stage, ...moves.map((m) => m.data.to)]);
  let since = Date.parse(deal.created_at);
  for (const m of moves) {
    const t = Date.parse(m.created_at);
    spent.set(current, (spent.get(current) || 0) + Math.max(0, t - since));
    current = m.data.to; since = t;
  }
  spent.set(deal.stage, (spent.get(deal.stage) || 0) + Math.max(0, now - since));
  const ordered = [...stages].sort((a, b) => a.position - b.position);
  const openStages = ordered.filter((s) => s.kind === 'open');
  const curIdx = openStages.findIndex((s) => s.key === deal.stage);
  const closed = ordered.find((s) => s.key === deal.stage && s.kind !== 'open');
  return openStages.map((s, i) => ({
    key: s.key, name: s.name, color: s.color,
    days: Math.floor((spent.get(s.key) || 0) / 86400000),
    // A closed deal only lights up the stages it actually passed through.
    state: closed ? (visited.has(s.key) ? 'done' : 'future') : i < curIdx ? 'done' : i === curIdx ? 'current' : 'future',
  }));
}

/** Pipeline totals per stage for the board header and the home page. */
export function stageTotals(deals, stages) {
  const out = new Map(stages.map((s) => [s.key, { count: 0, cents: 0 }]));
  for (const d of deals) {
    const t = out.get(d.stage);
    if (t) { t.count++; t.cents += Number(d.value_cents) || 0; }
  }
  return out;
}

/* ---------------------------------------------------------------- search ranking */

/**
 * Match quality: whole-text prefix, then a word that starts with the query, then any substring,
 * then initials ("rr" finds "Ruiz Roofing"). Loose letter-by-letter matching is left out on purpose:
 * it made "gat" find "Booking assistant".
 */
export function score(text, q) {
  text = String(text || '').toLowerCase(); q = q.toLowerCase().trim();
  if (!q) return 1;
  if (text.startsWith(q)) return 100 - text.length / 100;
  const words = text.split(/[\s\-_.@]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 80;
  const idx = text.indexOf(q);
  if (idx >= 0) return 60 - Math.min(idx, 30);
  const initials = words.map((w) => w[0]).join('');
  if (q.length >= 2 && initials.startsWith(q)) return 50;
  return 0;
}
