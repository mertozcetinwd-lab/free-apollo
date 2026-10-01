# Import records with sources

Free Apollo runs on its own. Its **Find and enrich** page can create records without another app. Use **Import** when you already have a file from your own research or another tool.

1. Open **Prospecting > Import**. Choose a JSON file in the format below. The browser uploads five records per authenticated request. A file may contain up to 500 records and 2 MB.
2. Review the result count. Matching lowercased email for a person or normalized domain for a company is treated as an existing record. A record without a name or deduplication key is skipped. Existing values are not silently overwritten.
3. Open People or Companies and inspect field evidence. An imported value is **observed**, not verified.

The current file contract is `free-apollo-records-v1`. The older `free-apollo-transfer-v1` format remains accepted for files already exported from Free Clay.

```json
{
  "format": "free-apollo-records-v1",
  "kind": "companies",
  "exported_at": "2026-09-30T00:00:00.000Z",
  "records": [{
    "data": { "name": "Sample Workshop", "domain": "sample.example" },
    "sources": { "name": { "source": "Sample file", "url": "https://example.com/source", "at": "2026-09-30T00:00:00.000Z" } },
    "source": "Sample file",
    "observed_at": "2026-09-30T00:00:00.000Z"
  }]
}
```

Fields used by this version are `name`, `domain`, `industry`, `city` for companies and `full_name`, `email`, `title`, `city` for people. Individual source labels, HTTPS links and observation times are kept where available. An absent observation time is marked `unknown`; it is never treated as fresh evidence. Extra fields remain in the file but are not imported. CSV import and export are also available from the People and Companies pages. Import does not contact a provider or send a message.
