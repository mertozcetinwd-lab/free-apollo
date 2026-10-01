import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { handle } from '../src/index.js';

export const PW = 'correct horse';

/** A minimal D1 over node:sqlite: prepare/bind/first/all/run and an atomic batch() with RETURNING. */
export function fakeEnv() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const prepare = (text) => {
    let args = [];
    const s = {
      bind(...v) { args = v; return s; },
      async run() { sql.prepare(text).run(...args); return { success: true }; },
      async first() { return sql.prepare(text).get(...args) ?? null; },
      async all() { return { results: sql.prepare(text).all(...args) }; },
      runSync() {
        if (/RETURNING/i.test(text)) return { results: sql.prepare(text).all(...args) };
        sql.prepare(text).run(...args); return { results: [] };
      },
    };
    return s;
  };
  const DB = {
    prepare,
    async batch(stmts) {
      sql.exec('BEGIN');
      try { const r = stmts.map((x) => x.runSync()); sql.exec('COMMIT'); return r; }
      catch (e) { sql.exec('ROLLBACK'); throw e; }
    },
  };
  return { sql, DB, CRM_PASSWORD: PW };
}

/** Log in and return a fetch-like helper that carries the session cookie. */
export async function client(env) {
  const r = await handle(new Request('https://crm.test/api/login', { method: 'POST', body: JSON.stringify({ password: PW }) }), env);
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body) => {
    const res = await handle(new Request('https://crm.test' + path, {
      method, headers: { cookie }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    }), env);
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
  return {
    get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b), del: (p, b) => call('DELETE', p, b),
  };
}
