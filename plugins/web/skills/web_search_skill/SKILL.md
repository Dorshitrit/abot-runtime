# Web Search Skill

- Use `web_search` for current or external information.
- `web_search` requires `BRAVE_SEARCH_API_KEY`. If execution reports that the
  key is missing, do not retry; explain that the runtime operator must configure
  the environment variable and restart the runtime.
- For externally verifiable answer synthesis, prefer two or three distinct
  queries in the first call instead of a single query.
- Use `search_one` for one query and `search_many` for up to five distinct
  queries that should run in parallel.
- Treat `coverage_status` as an evidence-quality signal.
- Do not invoke `web_search` more than twice consecutively for one user
  request. After the second completed call, stop searching and answer from the
  accumulated evidence with clear uncertainty when needed.
- Never use web search for local files, local paths, workspace content, or
  project state.
