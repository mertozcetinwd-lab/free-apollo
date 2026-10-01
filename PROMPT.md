# Build a standalone Apollo-style prospecting app

Build an independent, self-hosted app using one Cloudflare Worker, one D1 database, static assets and plain ES modules. It should reproduce Apollo's workflow as closely as the available data and permissions allow. It must not claim Apollo's licensed people database or affiliation with Apollo.io.

Give the user one path from finding a company to reviewing evidence, finding a person with an optional capped key, organizing a list, drafting a first message, planning a sequence and tracking a deal. Public sources are labelled and cached. Missing or failed lookups remain unknown. Every field used in a claim has a source and observation date. Unsupported claims remain `{{placeholder}}`.

Include local and public company search, saved people and companies, filters and views, lists, CSV and sourced JSON import, tasks, notes, deals, cost ledger, a source-backed draft, and ordered email, call, action and manual LinkedIn steps. Store timing, variants, schedule and safety rules. Sending is disabled until the owner separately authorizes and specifies a compliant send design.

Before each optional paid provider call, display its maximum and require explicit approval. Send the maximum to the provider, prevent duplicate concurrent searches, record the reported charge and flag missing charge data as unknown. Keep secrets out of code and logs. Do not scrape LinkedIn or probe mailboxes.

Test meaningful behavior, run mutation checks and exercise changed paths in local Wrangler. Compare three real companies against Apollo without copying private contact details into public artifacts. Publish a clean export only with the owner's authorization. See `PROMPT-FULL.md` for the detailed contract.
