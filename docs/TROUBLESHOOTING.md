# Troubleshooting

## Sign-in says setup is not finished

Run `npm run setup`, then `npm run dev`. For deployment, create a D1 database, replace the placeholder ID, apply the schema and set a strong `CRM_PASSWORD` Wrangler secret.

## Local business search asks for a contact address

Set `NOMINATIM_CONTACT_EMAIL` in the ignored `.env`, rerun setup and restart the local preview. The public place lookup sends that address in its User-Agent as required by [Nominatim's policy](https://operations.osmfoundation.org/policies/nominatim/). A search may also wait for the app's one request per second limit or a busy public Overpass server. Retry later, or import a sourced company file. A failed search is not a negative business finding.

## A records file skips or stops

People need a name and email; companies need a name and domain. Fix missing identifiers and retry. The status line reports completed rows. Earlier batches remain saved, and duplicates match by normalized email or domain. See [TRANSFER.md](../TRANSFER.md).

## A field says observed or unknown

Observed means a source supplied the field, not that an email is deliverable. Unknown means the source date or provider verdict was missing. Open the source link, then use the app's capped provider action only if you choose to spend from your own account.

## A cost row says charge_unknown

The provider did not send a usable charge header. Check provider usage before retrying. The row's zero is a storage placeholder, not proof of zero cost.

## Sequences do not send

This build stores drafts and planned people. It has no mailbox or send route. The AI OS plan currently pauses cold email and SMS.
