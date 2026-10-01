/** CSV in and out: a real parser for imports, and formula-safe cells for exports. */

import { fieldsFor } from '../public/js/schema.js';

export const MAX_IMPORT_ROWS = 5000;

/** RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes, BOM, CRLF. */
export function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** A cell that starts with = + - @ becomes a formula in Excel; prefix it so an export cannot run code. */
export function csvCell(v) {
  const s = v == null ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

/**
 * Header aliases seen in HubSpot, Pipedrive, Google Contacts and spreadsheet exports, per object.
 * Anything not listed still matches a field by its label or key ("Job title", "job_title").
 */
const ALIASES = {
  people: {
    'full name': 'name', 'contact name': 'name', 'person name': 'name', 'first name': '_first', 'last name': '_last',
    'given name': '_first', 'family name': '_last', 'email address': 'email', 'e-mail': 'email', 'e-mail 1 - value': 'email',
    'work email': 'email', 'phone number': 'phone', mobile: 'phone', 'mobile phone': 'phone', 'phone 1 - value': 'phone',
    'job title': 'title', position: 'title', company: '_company', 'company name': '_company', organization: '_company',
    'organization name': '_company', 'organization 1 - name': '_company', 'lead source': 'source', 'original source': 'source',
    'linkedin url': 'linkedin', 'linkedin profile': 'linkedin', notes: '_notes', note: '_notes', labels: 'tags', label: 'tags',
  },
  companies: {
    'company name': 'name', company: 'name', organization: 'name', 'organization name': 'name', website: 'domain',
    'website url': 'domain', 'company domain name': 'domain', 'number of employees': 'employees', 'employee count': 'employees',
    notes: '_notes', labels: 'tags',
  },
  deals: {
    'deal name': 'name', title: 'name', 'deal title': 'name', amount: 'value_cents', value: 'value_cents', 'deal value': 'value_cents',
    'deal stage': 'stage', pipeline_stage: 'stage', status: 'stage', company: '_company', organization: '_company',
    'organization name': '_company', 'company name': '_company', 'close date': 'close_date', 'expected close date': 'close_date',
    'contact person': '_person', contact: '_person', person: '_person', notes: '_notes',
  },
};

export function mapHeaders(object, headers, customFields = []) {
  const fields = fieldsFor(object, customFields).filter((f) => !f.readonly);
  const byName = new Map();
  for (const f of fields) {
    byName.set(f.label.toLowerCase(), f.key);
    byName.set(f.key.toLowerCase(), f.key);
    byName.set(f.key.replace(/_/g, ' ').toLowerCase(), f.key);
  }
  return headers.map((h) => {
    const k = String(h).trim().toLowerCase();
    return ALIASES[object]?.[k] || byName.get(k) || null;
  });
}

/** "$2,500.50" -> 250050 cents. */
export function toCents(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
