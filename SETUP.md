# Free Apollo setup

## Local preview

You need Node.js and a local Wrangler install from `npm install`.

1. Run `npm run setup` in `builds/free-apollo`. It installs local dependencies if needed, creates an ignored `.dev.vars` file and applies the local D1 schema.
2. Run `npm run dev` and open the printed local URL.

For a private local test, the setup command uses `preview` as the password unless you set `CRM_PASSWORD` in an ignored `.env` file first. Add `TREG_TOKEN` only if you want capped people and email provider calls. Add `NOMINATIM_CONTACT_EMAIL` if you want OpenStreetMap city lookup. It identifies this installation to the public geocoding service. Setup does not print these values.

The placeholder database ID in `wrangler.toml` is for local development. Do not deploy with it.

Existing local installs can apply later additive changes with `npm run migrate:local`. The command checks each table and sequence column before adding it, so it also works after a fresh setup. The discovery, sequence and source migrations keep existing records.

## Deployment preparation

Before deployment, create a D1 database named `free-apollo`, set its ID in `wrangler.toml`, apply `schema.sql` to that database, put a strong `CRM_PASSWORD` secret through Wrangler's interactive prompt, test sign-in and discovery, then deploy. Add `TREG_TOKEN` as an optional Wrangler secret only if you want provider calls. Add `NOMINATIM_CONTACT_EMAIL` if you want local business search by city. Review [Cloudflare's D1 guide](https://developers.cloudflare.com/d1/get-started/) and [Wrangler secrets guidance](https://developers.cloudflare.com/workers/configuration/secrets/) before running remote commands.

Wikidata search needs no provider key. OpenStreetMap city lookup needs an application contact address and follows [Nominatim's policy](https://operations.osmfoundation.org/policies/nominatim/). No mailbox connection is required. Secret values belong in Wrangler's secret storage and never in Git.
