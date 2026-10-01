# Full build specification

## Product

Free Apollo is a standalone prospecting workspace. Its database and user interface work without Free Clay or Free CRM. Apollo's licensed contact graph is unavailable, so show exactly which results came from public sources, imports or an optional owner supplied provider key. The name is a working label and the project is not affiliated with Apollo.io.

## Architecture

Use one Cloudflare Worker for an authenticated API and static assets, one D1 database, and plain ES modules. Keep source adapters, records, drafts and sequences separate. Keep migrations additive and test an old-shaped database before applying them. The local setup command creates an ignored password file and database. A public export must keep only a placeholder D1 ID and no secrets or real personal details.

## Search and records

Search public companies through Wikidata and local businesses through OpenStreetMap. Nominatim city lookup needs an identifying application contact address, a one request per second app limit, caching and attribution. Public Overpass servers may be busy. A failed call is retryable, not an empty result. Save a source link and observation date with each field. People search is optional BYOK. An imported or found email is observed until a verifier returns a strict valid verdict; catch-all and risky answers remain unverified. Drop sample addresses and LinkedIn data from provider output.

Provide editable people, companies, deals, notes and tasks; linked records; CSV import and export; saved filters; explicit lists; soft delete; and a source evidence view. A generic sourced JSON format carries field labels, HTTPS links and observation dates. Match duplicates by normalized email or domain. Preserve known evidence on repeated imports with missing dates.

## Engagement planning

Generate a first-message preview only from a cited company observation. Use `{{placeholder}}` when the source is missing. Save it as a draft sequence. Support automatic email drafts, manual email, phone call, action item and manual LinkedIn reminders; delay units; A/B labels; weekday and hour schedule; reply, meeting, out-of-office and bounce rules; daily cap; and planned people. These are stored plans. There is no mailbox connection, sending, tracking or dialer in the current build.

## Money and safety

Before an optional paid request, show a per-call maximum and require a deliberate confirmation. Send `X-Treg-Route-Max-Cost`, reject requests over the cap, log `X-Treg-Cost-Micro`, and mark missing charge headers as unknown. Use a lock so two simultaneous identical searches cannot both spend. Do not treat an error as a negative finding. Do not add SMTP probing, LinkedIn scraping, outbound calls or live sending without separate scope and authorization.

## Proof and publication

Run Node tests, mutation checks, local Wrangler smoke and visual review using fictional screenshots. Compare the same three-company workflow with Apollo and report which steps were actually measured. No real people's names, emails or phones enter public artifacts. Push only to the owner's `origin`, export the app cleanly to its own public repo and check CI. A live deployment needs a configured D1 database and strong secret, then a separate smoke check.
