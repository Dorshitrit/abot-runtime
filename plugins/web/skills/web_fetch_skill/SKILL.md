# Web Fetch Skill

- Use `web_fetch` only for exact public HTTP or HTTPS URLs or standalone URL
  fetches.
- Use `fetch_one` for one URL and `fetch_many` for up to three URLs.
- Do not use `web_fetch` for discovery; use `web_search` for discovery when its
  Brave API key is configured.
- Never use it for local files, local paths, workspace content, file URLs,
  localhost, or private-network targets.
