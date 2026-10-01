import { fail } from './util.js';

const clean = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const idOf = (value) => { const id = Number(value); return Number.isInteger(id) && id > 0 ? id : fail(400, 'Choose a company'); };

/** Deterministic, source-backed first-message preview. No model or send call. */
export async function draftFirstMessage(db, input) {
  const companyId = idOf(input?.company_id);
  const offer = clean(input?.offer, 180);
  if (!offer) fail(400, 'Describe the offer');
  const company = await db.prepare('SELECT id,name,industry,city FROM companies WHERE id=?1 AND deleted_at IS NULL')
    .bind(companyId).first();
  if (!company) fail(404, 'Company not found');
  let person = null;
  if (input?.person_id !== undefined && input.person_id !== null && input.person_id !== '') {
    person = await db.prepare('SELECT id,name,title FROM people WHERE id=?1 AND company_id=?2 AND deleted_at IS NULL')
      .bind(idOf(input.person_id), companyId).first();
    if (!person) fail(400, 'Choose a person linked to that company');
  }
  const { results } = await db.prepare(`SELECT field,source,source_url,observed_at,status,detail FROM prospect_evidence
    WHERE kind='companies' AND record_id=?1 AND field IN ('industry','city')
      AND status IN ('observed','verified') AND source_url LIKE 'https://%'
    ORDER BY observed_at DESC LIMIT 10`).bind(companyId).all();
  const matches = (row, value) => value && row.detail === `Value at observation: ${value}`;
  const supported = results.find((row) => row.field === 'industry' && matches(row, company.industry))
    || results.find((row) => row.field === 'city' && matches(row, company.city));
  const observation = supported?.field === 'industry'
    ? `I saw ${company.name} listed under ${company.industry}.`
    : supported?.field === 'city'
      ? `I saw ${company.name} listed in ${company.city}.`
      : '{{source-backed observation about the company}}';
  const firstName = person?.name?.split(/\s+/)[0] || '{{first_name}}';
  const subject = `Quick idea for ${company.name}`.slice(0, 180);
  const body = `Hi ${firstName},\n\n${observation}\n\nCould ${offer} help your team handle incoming calls? I can share a short example tailored to your current process.\n\nWould a brief look be useful?\n\n{{sender_name}}`;
  return { subject, body, source: supported ? { field: supported.field, label: supported.source,
    url: supported.source_url, observed_at: supported.observed_at } : null,
    review_required: true, sending_enabled: false };
}
