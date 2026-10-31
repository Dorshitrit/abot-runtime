# Information basket

The basket is a personal source registry shared by conversations in one Runtime.
The Resources workspace manages sources. The built-in `information_basket`
capability exposes search and bounded reads to agents. The module owns its
settings, persistent index, file access, and indexing lifecycle independently of
long-term memory and installed plugins.

## Registration and indexing

- Choose an existing file using the Runtime-host filesystem picker, or enter an
  explicit absolute path. Browser drag-and-drop is not offered: it cannot provide
  the original Runtime-host path, and Resources does not upload file copies.
- The picker supports selecting all supported files in the current folder, including
  paginated entries, without traversing subfolders. Registration is one atomic
  batch bounded by the existing 200-source basket capacity.
- Registration grants read access to that exact canonical source, not its parent
  directory. Agent reads resolve registered IDs and revisions, never arbitrary
  caller-supplied paths.
- Select an existing embedding profile in Resources. Basket settings do not
  enable long-term memory or require a generative summarizer.
- Text, text-bearing PDFs and DOCX documents are supported. PDF parsing runs in a
  bounded isolated process. DOCX uses the independent byte-only document-text
  library, shared through the SDK with optional consumers. Resources never imports
  or enables an installed plugin. File grants, identities, revisions and complete
  indexing remain owned here; truncated extraction is rejected. OCR, legacy DOC,
  other Office formats and live Google Docs are not supported.
- Indexing reads the source transiently, chunks its contents and embeds the chunks.
  The persisted index contains locators, revisions, hashes and vectors, not a copy
  of the full extracted document. A complete new index is published atomically.
- Removing a source removes its registration and index. It never deletes the
  original file or already settled conversation evidence.
- A missing or changed source must be refreshed explicitly. Reading an outdated
  revision fails; it does not silently substitute new content.
- Relink explicitly replaces one source's canonical path through Web management.
  It preserves the source ID, requires its current revision, increments that revision,
  and queues a complete replacement index. A path already registered to another
  source is rejected atomically. Invalid paths and stale revisions preserve the
  existing registration. Original files and settled conversation evidence remain
  untouched; Relink is not a model capability.

## New chat uploads

Resources includes an opt-in `indexChatUploads` setting, off by default (including
existing stores). Saving it never scans historical messages or attachments.
The Web upload route captures the environment owner's settings revision before
reading the upload body, then registers only a successfully stored, supported file.
Changing settings during an upload revokes its admission; toggling off and back on
does not admit an older in-flight upload. Foreign-origin browser uploads cannot register sources. The owner validates session ownership,
resolves the stored attachment path and commits it through the ordinary registration
transaction. Exact paths are deduplicated; display names retain the uploaded name.

No second file copy is made. Removing a draft attachment or deleting its chat can
remove that source file; normal source-health checks then make it unavailable.
Registration queues the existing index worker and never waits for embeddings.
Paused or unconfigured indexing leaves it queued. Unsupported uploads remain chat
attachments only. Registration failure does not fail the upload. Turning the option
off stops future additions; already registered sources remain until removed.
Changing only this preference neither interrupts indexing nor invalidates retrieval.
The management RPC seam is not a model capability and does not enable SUPER access.

## Agent access

The core plugin captures retrieval availability during the existing request
preparation for the Execution Agent root contract only. It is offered when the service is started, the basket is
enabled, an embedding profile and provider are configured, and at least one
ready index matches that profile. This check uses the committed in-memory
snapshot, without filesystem or provider calls. Otherwise all basket operations
are omitted from that request's catalog and background discovery. The catalog remains stable for that request; a later readiness change
applies to the next request preparation, including approval resume. Source reads
still enforce their existing live settings and revision checks. Captured evidence
and Web management remain available independently of this discovery gate.

The model's source list includes only READY sources. Pagination, cursors and
omitted counts apply only to that filtered list. Queued, indexing and unavailable
sources remain visible in Web management but are excluded from model discovery.

Before returning search matches, the service checks the filesystem identity of
only a bounded candidate window (at most eight), including metadata-only discovery.
Returned and omitted-match counts include only verified candidates in that window;
unchecked vector hits are not advertised as additional usable sources.
Explicit model LIST checks the ready registry before pagination. These checks
never load document bodies, parse PDFs, hash contents or invoke embeddings.
LIST returns only the exact ready bindings inspected by that call; revisions
that finish indexing during verification wait for a subsequent explicit LIST.
Selected reads retain their complete content-hash and identity verification.
A changed or missing file atomically loses its ready index until explicit re-index.
Old conversation evidence remains intact; there is no stored-schema migration.

Background discovery searches only completed indexes. It never waits for an
indexing job or indexes missing documents on demand. Search begins asynchronously
and its result may be consumed at the next eligible root decision. No model call
is started solely to deliver an index result, and completion is never held open
for optional discovery.

Candidates are passive request-local metadata, bound to the request and current
user-intent revision. They do not create user messages, assignments, action
authority, pending work, or completion evidence. They expire on disposal or intent
change and are dropped before compaction if mandatory context needs the space.

SUPER has no basket selection phase, search/read actions, retrieval instructions,
source projections or background discovery. Its Planner and Worker calls receive
no basket capabilities or Information Basket Skill, including explicit Skill
LIST/READ. The frozen root contract is passed to existing module preparation;
the basket module owns its EA-only availability. Shared Skill request views use
trusted definition metadata for the same restriction. Other Skills are unchanged.

EA keeps bounded passive metadata and ordinary core capability execution.
Its passive candidate projection prioritizes display names and exact source IDs and
revisions within the existing 512-token ceiling. Paths, scores, chunk locators and
content are excluded. Names may be shortened and omitted sources remain counted;
mandatory context retains priority. This metadata never triggers a source or Skill read.

Resources settings offer three matching modes: Flexible (0.3), Balanced (0.6),
and Strict (0.9). Balanced is the default for new and existing stores without a
saved mode. The mode applies to content similarity in both background discovery
and explicit search. A complete registered display name or a sequence of at least
two consecutive complete words from its stem admits that source below the content
threshold. Complete names rank before word sequences, then content-only matches.
Name matching ignores case, canonical Unicode encoding and whitespace differences;
word sequences also allow underscores and dashes between words. File extensions
are not name words. Single words, word fragments and reordered words receive no
name priority. Names do not create aliases or infer which source to read.
Duplicate names retain separate source IDs. The returned score and chunk locators
still describe the best content matches; no synthetic similarity is assigned.
Existing ready-index compatibility, provider availability, source verification,
result limits and cancellation still apply. No index rebuild or storage change is
required. LIST and selected reads remain independent of similarity. Changing mode invalidates
pending search results and passive candidates through the existing settings
notification, without changing source revisions or re-indexing. Old settings clients
that omit the field preserve the saved mode. Scores measure similarity, not certainty.

The Information Basket Skill declares its required operations and eligible request
root in its definition. A match alone requires neither a source nor a Skill read.
Explicit Skill reads in EA remain independent of source readiness.
EA guidance directs requested file lookups through LIST, SEARCH or READ, including
when automatic matches are absent; unclear lookup intent calls for clarification.
Unread content does not establish denied access or justify requesting a re-upload.
Background matches alone still require no action.
Read results carry exact source/revision/hash and coverage; longer reads continue
using explicit offsets. Selected reads become ordinary settled tool evidence.

Historical SUPER receipts retain storage validation so existing saved checkpoints
remain readable. No new native basket receipt can be committed, and the SUPER
input builders no longer project these references. Historical conversation and
activity records are not erased.

## Activity events

Passive discovery emits a bounded `runtime.state` message only when matching
candidates are consumed at a natural decision boundary. The background promise
does not emit an event, wake the model or prolong the request. Repeated delivery
of the same source revisions for the same user-intent revision is suppressed.

EA operations use the existing `tool.started` / `tool.completed` event path.
Search events show the returned count and up to five source names; read events
name the source when known. Successful reads also show the returned character
range and whether more text remains. Nonzero offsets are labelled as continuation
reads; reaching the end of one range does not claim that earlier ranges were read.
Old events without coverage retain their original presentation.
Empty searches and unavailable lookups are distinct.
Omitted names and further search results have separate counts.

Activity labels are bounded and rendered as inert text. They contain no document
body, search query or source path. Tool-result event metadata is a pure projection
from the existing output JSON; it does not change canonical results, evidence
fingerprints or model-visible context. Live and replayed Web activity use the same
projection and preserve active tool status during passive discovery.

## Lifecycle and isolation

The Runtime owner is the single service owner. Web clients use allowlisted
management RPC methods and receive committed state invalidations. The table
refreshes after changes and reconnects; no browser-side indexing is involved.

Store identity includes the Runtime host namespace. Embeddings are compatible
only with their recorded profile binding, model fingerprint, dimensions and
chunker version. Requests never share candidate caches. Disable, removal,
cancellation and shutdown fence or cancel outstanding work. Shutdown joins active
indexing, direct reads and searches; only explicit service startup reopens them. A provider returning
a different embedding fingerprint makes retrieval unavailable until the affected
sources are explicitly refreshed; searching never mutates or rebuilds the index.
Changing the selected profile queues complete replacement indexes in the background.

Committed notifications distinguish settings changes, invalidated ready source IDs,
and newly ready sources. Unrelated queued/indexing progress refreshes the Web table
without cancelling an in-flight optional search or discarding unaffected candidates.
Invalidation removes pending and cached matches without starting another optional
search for the same user intent. Newly ready sources can enable another attempt.

One environment-owned health sweep checks READY file metadata on startup and
30 seconds after the previous sweep settles. UI refreshes and model turns do not
schedule additional sweeps. Disabled/unconfigured baskets perform no sweep IO.
Sweeps, selected search checks and explicit LIST share at most four physical
metadata operations, deduplicate in-flight bindings and retain no success cache.
Workers yield between checks and stop scheduling on cancellation/deadline; a
non-cancellable filesystem call holds its physical slot until settlement. Each
batch commits invalidations once, without rewriting the store per invalid file.
Shutdown cancels the sweep and releases its timer and subscription. Capability
readiness stays synchronous and follows committed invalidations on the next
request preparation. A filesystem change after validation may still race a
later read, which continues to fail safely.

Resource ceilings and initial retrieval constants live in `limits.ts`. Relevance
scores are heuristics, not proof that a source answers a question. A model must
read selected content before relying on it.
