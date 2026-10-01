# Free Apollo agent instructions

Free Apollo is a standalone app. It owns its Worker, D1 database and static assets. No Free Clay or Free CRM installation is required. When working inside the original AI OS repo, read its `CLAUDE.md`, `AGENTS.md` and teardown playbook first.

- Use additive migrations and preserve existing local rows. Test changes in Node and under local Wrangler.
- Keep real people's names, emails and phones out of tests, docs, screenshots, chat and commits. Use fictional `example.com` fixtures.
- Do not add live sending, SMTP probing, LinkedIn scraping or uncapped paid calls. Require the owner's explicit go for new paid actions.
- A failed source or missing field stays unknown. Never make a negative claim from silence.
- Keep field source links and observation dates. Imported email is not verified. A generated claim without evidence stays `{{placeholder}}`.
- Never commit `.env`, `.dev.vars`, local D1 state or real credentials.
- Run `npm test` and `npm run mutate`. Smoke changed paths with `npm run dev`, then stop the server.
- Use short, direct prose with no em dashes.
