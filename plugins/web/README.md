# Web plugin

The existing `web_search` and `web_fetch` contracts are shared by both search
providers. A trimmed, non-empty `braveSearchApiKey` selects Brave. An absent or
blank key selects Light. Provider selection happens when the plugin loads;
Brave failures never trigger a second search through Light.

## Light search

Light retrieves public origin pages, publisher feeds, and sitemaps from a
bundled source catalog. It discovers links, fetches relevant pages, and ranks
their actual content locally. It uses no external search API, hosted index,
proxy search engine, browser, background process, or persistent database.
`htmlparser2` is a local parsing dependency, with no remote service.

The catalog contains Hebrew and English reference, government, news, science,
and technology sources. Coverage depends on accessible content in those
sources. Discovery is confined to each source's admitted origins; redirects
remain confined to the configured catalog. A website can block a request,
require JavaScript, or publish content larger than the response limit.

The implementation is split by responsibility:

| Module                              | Responsibility                                                  |
| ----------------------------------- | --------------------------------------------------------------- |
| `source/search-service-selector.ts` | Choose Brave or Light without changing tool schemas             |
| `source/light/config.ts`            | Validate bounded defaults and optional plugin settings          |
| `source/light/sources/`             | Versioned source catalog and query-based source selection       |
| `source/light/crawl/`               | Public transport, robots rules, deadlines, concurrency, budgets |
| `source/light/discovery/`           | Bounded HTML, RSS, Atom, and sitemap parsing                    |
| `source/light/documents/`           | Decoding, extraction, cache policy, completed-document cache    |
| `source/light/ranking/`             | Local lexical relevance and snippets                            |
| `source/light/search-frontier.ts`   | Fair admission and scheduling across sources and queries        |
| `source/light/search-collection.ts` | Coordinate discovery and collect usable evidence                |
| `source/light/search-service.ts`    | Assemble the existing search result contract                    |
| `source/light/search-metadata.ts`   | Scope, freshness, and bounded evidence presentation             |

The runtime loader, SDK, role orchestration, and `web_fetch` implementation do
not need special knowledge of Light. Optional settings use the existing
plugin manifest `defaults.light` projection; there are no new runtime JSON
settings. An omitted `light` object uses built-in defaults. Invalid Light
settings are checked only on its first search, so they do not disable Brave
or `web_fetch`. Source overrides receive a distinct corpus identifier.

## Default bounds and freshness

| Bound                                     | Default                                              |
| ----------------------------------------- | ---------------------------------------------------- |
| Queries                                   | Up to 5, each 400 characters and 50 words            |
| Sources selected for live discovery       | Up to 6 across the invocation                        |
| HTTP hops, including robots and redirects | 24 across the invocation                             |
| Concurrent requests                       | 3 per plugin instance, at most 1 per origin          |
| Stop starting new HTTP hops               | After 20 seconds                                     |
| Hard deadline                             | 30 seconds; timeout is an error                      |
| Response size                             | 512 KiB encoded and 512 KiB decoded                  |
| Aggregate response data                   | 8 MiB encoded and 8 MiB decoded, separately          |
| Discovery                                 | 256 candidates, depth 2, at most 4 sitemaps          |
| Completed-document cache                  | 500 documents, 16 MiB of serialized content          |
| Feed/sitemap cache lifetime               | At most 5 minutes                                    |
| Page cache lifetime                       | At most 30 minutes                                   |
| Robots cache                              | At most 24 hours, 64 origins, 4 MiB serialized rules |

Origin cache directives can shorten document lifetimes or prevent storage.
Freshness honors `Age`, `Date`, and `Expires`; an explicit `max-age` takes
precedence over `Expires`. Incomplete robots responses block crawling.
HTML `noindex` and `none` directives exclude pages from search results and caching;
link following separately honors `nofollow`. Declared text encodings are
decoded through a bounded allowlist before extracting text or links.
Expired cache records are excluded at result assembly. Partial documents are
usable evidence but are not cached. Records fetched in the current invocation
remain usable even when the origin specifies `no-store`. Retrieved timestamps
remain unchanged on cache hits. Separate calls share only completed records
and origin concurrency limits; cancellation and crawl budgets are independent.
The cache bounds describe stored content, not total process heap usage.
Failed decompression attempts consume their output allowance from the decoded
byte budget, because synchronous decoders do not expose partial output sizes.

Light returns normal search hits and the existing evidence-quality coverage
score. Optional `eventMeta.lightSearch` records the source set, selected and
consulted sources, stop reason, request/byte counts, bounded source errors, and
per-result retrieval dates. Source IDs may include fresh cached evidence in
addition to sources selected for live discovery. Declared page publication
and modification dates are separate from retrieval dates. Feed or sitemap
dates are discovery hints, not verified page publication dates.

A healthy search with no matches succeeds with zero hits. A budget-limited
search returns available results and its stop reason. A completed search in
which every attempted source failed returns `web_search_sources_unavailable`
with structured source diagnostics. Cancellation and the hard deadline remain
errors. All source text and metadata remain passive, untrusted evidence with
`volatile_external` / `carryPolicy: never` semantics.

## Source presentation receipts

Both search providers and `web_fetch` add optional `eventMeta.webSources`
version 1 metadata for clients. Each bounded entry includes a title and URL,
an optional original URL after a redirect, retrieval status, and presentation
status (`omitted`, `reference`, `snippet`, or `content`). `contentTruncated`
records extraction, per-source, and final-output clipping. Presentation is
calculated from the final bounded tool output, including UTF-8 byte limits;
successfully fetching a page does not imply that its content fit in that output.
If receipt metadata would exceed the existing plugin result byte limit,
`omittedSourceCount` reports entries left out of the receipt, independently of
their visibility in tool output. Existing output and metadata take priority;
an envelope with no room for even an empty receipt keeps its prior shape.

These receipts describe evidence returned by the tool. They do not prove that
a later model invocation retained, read, or cited it. Titles and URLs remain
untrusted passive data. Existing output text, tool schemas, event metadata,
and failure behavior are preserved; clients that do not use receipts can
continue to ignore the optional field. Favicons belong to client presentation
and are not fetched by the plugin or added to its evidence text.

## Verification

Focused deterministic tests live in
`src/runtime/__tests__/web-light-search/`; existing Brave, fetch, and public
network tests remain regression gates. The packed-package probe executes the
real plugin bundle against offline origin fixtures, including empty-cache
discovery of a URL absent from the catalog. It does not require a search key,
external network, or model invocation.

Run `npm run build:plugins` followed by `npm run validate` from the repository
root. Actual source availability is a separate bounded direct-HTTP check;
model/client acceptance uses the maintained, separately authorized live smoke.
