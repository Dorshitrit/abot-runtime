# Web Fetch Tool Instructions

- Read page content with `web_fetch` from exact public HTTP or HTTPS URLs
  supplied by the user or found in search results or retrieved content.
- Copy URLs unchanged from their source. Never invent URLs or repair article
  paths, including after a failed fetch.
- Use `fetch_one` for one URL and `fetch_many` for up to three URLs.
- A missing exact URL is an unmet prerequisite for this fetch; do not fabricate
  controls to continue.
- Do not use `web_fetch` for discovery.
- Never use it for local files, local paths, workspace content, file URLs,
  localhost, or private-network targets.
