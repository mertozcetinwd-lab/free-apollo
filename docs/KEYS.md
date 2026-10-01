# Keys and costs

The standalone app requires only `CRM_PASSWORD` to sign in. `npm run setup` reads it from an ignored `.env` file for local preview. It uses `preview` if the file has no password. Do not use that preview password for a deployed site.

`TREG_TOKEN` is optional. It enables people search and work email finding and verification inside Free Apollo. Put it in the ignored `.env` for local setup, or add it as a Wrangler secret for a deployed install. Never put a token in `wrangler.toml` or a command line. Free Apollo does not need Free Clay or Free CRM to run.

`NOMINATIM_CONTACT_EMAIL` enables city lookup for OpenStreetMap local business search. The public Nominatim service requires an identifying application User-Agent and limits the whole app to one request per second. Free Apollo caches place lookups for 30 days and enforces that rate in D1. Your contact address is transmitted to Nominatim in the User-Agent. Set it in the ignored `.env` for local setup. See the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/). The app does not auto-search places.

Each people search has a $0.100 maximum. Work email finding has a $0.020 maximum, and verification has a $0.010 maximum. These are caps sent to treg, not quotes or observed charges. The app records the provider's reported charge and reuses a search result for seven days. No call runs until the user confirms the cap. Check [treg](https://treg.to/) for current provider terms and account balance before a real run. Provider calls may spend real money if the account has a paid balance.

Apollo credits from the teardown are a separate account allowance. This app does not spend them. The measured trial use is summarized in [the comparison](APOLLO-COMPARISON.md).
