# Data and evidence

Free Apollo owns one D1 database. People, companies, deals, tasks, notes and activity live alongside lists, draft sequences, search results, source evidence and a cost ledger. It does not read another app's database.

**Find and enrich** can search Wikidata companies and OpenStreetMap local businesses. A city lookup uses Nominatim only after you set a contact address. Public data is uneven. A missing company, field or map result is unknown outside that specific search. Results and dates are cached. The app keeps an OpenStreetMap object link or Wikidata entity link for each saved field when available. Review those links before using the record.

An optional owner supplied treg key can search people and find or verify a work email. Every paid request has an explicit maximum, provider header cap and ledger row. A provider error remains retryable. If the provider omits its charge header, the ledger says `charge_unknown`; zero in that row does **not** mean the request was free. A found email is observed, not verified. A catch-all or uncertain verdict stays unverified. Sample addresses are rejected from provider results.

The JSON import accepts source labels, HTTPS links and observation dates per field. It matches people by email and companies by domain, keeps existing values, and reports skipped rows. A missing date is `unknown`, not fresh evidence. Reimporting a file without a date does not erase an earlier observed date or source link. CSV import and export are also available on People and Companies. CSV export escapes spreadsheet formulas.

The message draft uses only an observed or verified company field with an HTTPS source link and the same value recorded at observation time. If someone edits the field later, it emits `{{source-backed observation about the company}}` until new evidence is saved. Every draft requires review. It has no send path, mailbox ingestion or LinkedIn scraper. See [the import contract](../TRANSFER.md).
