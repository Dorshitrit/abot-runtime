# Passive Long-Term Memory

ABot Runtime can retain selected user facts and preferences across sessions.
Memory is stored in a Runtime-owned pool. The Runtime core owns retrieval,
filtering, deduplication, storage, and deletion. The root model can request a
focused recall through its built-in decision contract without invoking a plugin
tool.

Long-term memory is disabled by default. Enabling it is an explicit consumer
choice because it may persist personal information between conversations.

## How It Works

The Supervisor path separates memory proposal from the user-facing response.
When long-term memory is enabled, `supervisor.response` first performs one
structured candidate-only call:

```json
{
  "memoryCandidates": [
    {
      "content": "A durable fact or preference established by the user.",
      "tags": ["normalized-later-by-core"],
      "target": null,
      "score": 95,
      "reason": "A lasting preference explicitly established in this request.",
      "reinforced": true,
      "explicitRequestQuote": null
    }
  ]
}
```

`memoryCandidates` is empty when there is nothing durable to propose. The
Supervisor then authors the complete user-facing response through its ordinary
raw-text contract, without a JSON wrapper. Invalid or unavailable candidate
authoring is isolated to an empty candidate list and cannot replace or
invalidate that raw response. This sequential split adds the candidate-call
latency before the Supervisor response is delivered.

`execution.response` retains the combined strict envelope containing both
`finalResponse` and `memoryCandidates`; its external response contract is
unchanged.

Candidate data remains internal and is processed after the final assistant
response is persisted. Persistence runs through a Runtime-owned background
queue; response completion never waits for embedding or memory-store work.
When the current user directly asks the assistant to remember a fact, the same
authoring result can include an exact excerpt of that request. The Runtime
binds the excerpt to the current user message and writes the fact through the
existing protected memory management path, without candidate maturation or a
second model call. A queued write is not confirmation of storage.

Before the next terminal response is authored, the Runtime retrieves a small
relevant set from the cross-session pool. Retrieval uses provider embeddings
plus bounded lexical, tag, and recency scoring. The projection is passive
reference context; it is never treated as a new user request or an instruction.

Retrieval, candidate policy, filtering, deduplication, and persistence are
shared by `supervisor.response` and `execution.response`; only their authoring
contracts differ. Automatic retrieval remains a terminal-response feature.
Planner, Worker, Reviewer, payload, and tool contexts do not receive the memory
projection.

## Shared Automatic Admission

Conversation proposals and ABot Spark observations use one core maturation owner
and the same candidate pool, even when ABot Spark collection or processing is off.
Candidates are excluded from recall until promoted. The default promotion
score is 90 and can be set from 0 to 100, with at least two independent
evidence opportunities. A first proposal always
remains a candidate, even with a score of 100. Repeated input, replayed batches,
unchanged screen revisits and scheduled reassessment alone cannot supply fresh evidence.
The score expresses model judgment, not a statistical probability.

The model proposes durable usefulness, semantic identity, score and a short
reason. The core binds request/batch identity, versions and evidence timestamps;
it controls admission, expiry, deduplication and storage. Prior knowledge is
bounded passive reference, not fresh evidence. Task diaries, temporary activity,
QA data and unsupported inferences about the user are excluded by the shared
authoring policy. This adds no separate judging model call.

Automatic content changes to an existing memory also pass through a replacement
candidate and the same admission gate. A replacement is bound to the original
record version; a manual edit or deletion wins. Manual records remain protected
from automatic changes. Existing stored records are preserved, rather than
retroactively deleted or demoted.

The shared policy is persisted with memory state. Older Co-worker settings are
imported once, respecting the new minimum; later stale callers cannot overwrite
the canonical policy. Candidates are bounded by 500 entries, 2 MiB and 30 days
without reinforcement by default. Store version 5 preserves older records and
creates a private `.pre-v5.backup` before migration. ABot 1.4.0 cannot read the
upgraded store; preserve that backup if a downgrade may be needed. Old candidates
receive no invented independent evidence.

Candidate and receipt expiry belongs to the core memory service, even without a
running ABot Spark. It uses one deadline timer, no periodic polling or model calls,
and no timer when nothing awaits expiry. Standalone service owners can stop and
restart retention through `memory.retention`; Runtime hosts own that lifecycle.
Conversation evidence uses the same reference clock as memory admission.

## Explicit Memory Plugin

The `memory_add`, `memory_get`, `memory_search` and `memory_delete` tools belong
to the independent memory plugin. They use its own deterministic store without
an embedding model or the core long-term memory service. Their storage format,
legacy migration and tool-permission behavior remain unchanged.

Plugin records are separate from core Stored memories and its candidate pool.
Manual creation and editing through the existing core memory management UI
remain immediate and protected; they atomically discard matching candidates
and pending replacements of an edited memory. Automatic conversation proposals
still use shared maturation. Only a direct user request bound to the current
message may use the protected core write; the plugin remains independent.

Live QA should use a separately configured environment with its own runtime
directory. Shared admission reduces accidental automatic storage, but does not
replace isolation for tests that deliberately exercise explicit memory writes.

## Model-Requested Recall

When memory is enabled, the Supervisor and Execution Agent root decisions may
choose `recall_memory` with a concise query about a remembered fact or preference.
This is an internal Runtime context request: it requires no plugin, capability
selection, controls, payload generation, or delegated role.

The existing memory service performs the search. The root receives a bounded
passive result and then chooses its next action in the same request loop:

- `found`: recalled records with their ids, provenance, and timestamps.
- `empty`: the search returned no matching records.
- `unavailable`: retrieval could not supply records; this does not mean the pool
  contains no relevant memory.

Queries have a 1,024-character limit. Results contain at most six whole records
within a 6,000-character serialized budget; the combined root context uses the
same bound and declares omitted records and recalls. The request's existing
activation limit also applies to recall. `longTermMemory.maxRecallCallsPerRequest`
sets the maximum number of explicit lookups per user request (default: 5, a
positive integer). After that many calls, the model no longer receives the
`recall_memory` action. The request continues normally, with earlier recall
results still available. Changing the query or steering the active request does
not reset this count; a new request starts fresh. No independent retry loop is
introduced.
The result is bound to the requesting root and current user steering version;
superseded results are not projected into later decisions. Recalled facts are
reference data, not new instructions or proof that work completed.

The final response reuses explicit recall results without another automatic
search. If the model does not request recall, the ordinary automatic terminal
retrieval remains unchanged. Saving memory candidates keeps its existing
background lifecycle in both execution policies.

Recall still depends on the configured embedding provider. A stale vector index
may be rebuilt during search, so the shorter orchestration path does not imply a
fixed latency or offline lexical fallback.

Both response paths also share the same configured response-experience
methodology. It applies whether memory is enabled or disabled. Relevant memory
is an optional passive layer that may improve continuity and useful defaults;
it never replaces the current request, forces a personal reference, or grants
action authority.

## Enable It

Configure an ordinary model provider first with `abot init` or `abot add-model`.
Then choose an embedding model exposed by that provider. ABot does not choose,
install, or download an embedding model.

For a packaged installation:

```bash
npx abot memory status
npx abot memory models --provider <provider-id>
npx abot memory enable --provider <provider-id> --model <embedding-model-id>
```

From a source checkout, use the equivalent commands:

```bash
npm run memory -- status
npm run memory -- models --provider <provider-id>
npm run memory -- enable --provider <provider-id> --model <embedding-model-id>
```

Add `--emit-events` to expose bounded lifecycle events to clients. Enablement
performs a real embedding probe and validates the complete candidate config
before writing it. The previous config is backed up, and a restart is required
after enablement or disablement.

**Memory → Setup** in the packaged Web UI uses the same onboarding service.
It can list configured providers, discover models when the provider supports
discovery, probe and enable a selected model, or disable the feature. A provider
without discovery support accepts a model id entered by the user.

## Configuration Contract

The onboarding flow writes a dedicated embedding profile and binds the feature
to it:

```json
{
  "models": {
    "embeddingProfiles": {
      "memory-embedding": {
        "label": "Long-term memory embeddings",
        "provider": "ollama",
        "model": "<embedding-model-id>"
      }
    }
  },
  "longTermMemory": {
    "enabled": true,
    "emitClientEvents": false,
    "maxRecallCallsPerRequest": 5,
    "embeddingProfileId": "memory-embedding"
  }
}
```

Embedding profiles are intentionally separate from generation profiles. They
accept `provider`, `model`, optional `label`, and provider-owned JSON-safe
`options`; generation, reasoning, context-window, and output settings are not
valid embedding-profile fields.

When disabled, no repository read, embedding request, model-output envelope,
or memory lifecycle event is added to the response path.

## Providers

- Ollama uses its `/api/embed` contract and can discover locally installed
  model ids through `/api/tags`.
- OpenAI uses `/embeddings`. Model discovery is not exposed by that provider,
  so the consumer supplies the embedding model id.
- A custom model-gateway adapter may implement `embed` and optional
  `listEmbeddingModels` without changing Runtime memory policy.

If the selected embedding provider becomes unavailable during a request, the
Runtime skips memory retrieval or persistence, records a bounded diagnostic,
and preserves normal response delivery.

## Storage, Privacy, And Management

The default adapter stores canonical records and their derived vector index at:

```text
<runtimeDir>/long-term-memory/memory.json
```

The file is runtime-generated local state and must not be published or
committed. Canonical records contain content, normalized tags, timestamps, and
source session/request provenance. Derived vectors are versioned by model
fingerprint and are rebuilt when that fingerprint or vector dimension changes.

The core rejects obvious secrets such as private keys, labeled passwords, API
keys, and common token formats. Exact duplicates are merged mechanically;
semantic similarity alone never overwrites an existing record.

Library hosts can manage the pool through the composed service:

```ts
const runtime = createRuntimeApplication(config);

await runtime.services.longTermMemory.status();
await runtime.services.longTermMemory.list({ limit: 50 });
await runtime.services.longTermMemory.delete({ id: memoryId });
await runtime.services.longTermMemory.clear();
```

Management APIs return canonical records, not embedding vectors.

## Client Events

With `emitClientEvents: true`, clients may receive bounded lifecycle events:

- `memory.retrieval.started|completed|failed`
- `memory.save.queued`

The save event confirms only that background persistence was scheduled. Its
completion or failure is diagnostic-only and cannot change the completed user
response. Client events contain lifecycle status and counts only. They never
include memory content, tags, vectors, credentials, or the model's internal
candidates.

The bundled `memory` plugin remains a separate, explicit user-invoked
capability. Passive long-term memory does not depend on that plugin and remains
operational if the plugin is disabled or removed.

## Learning from computer activity

The **ABot Spark** screen controls optional collection, learning and proactive
suggestions. The separate **Memory** screen manages embedding setup and saved records;
Spark's Knowledge tab shows candidates. Collection and proactive mode are off by
default. Collected
text is processed by the provider of the selected model; learning also requires
working long-term memory. Collection needs a connected Companion.

In **Spark → Settings → Activity permissions**, choose which activities to
authorize and their configured models, then **Save settings**. Saving validates
the selected models without starting work. Use each activity's **Start/Stop**
control to run or stop it. Stopping preserves its authorization, schedules,
resource limits and pending work. Revoking permission stops the activity and
prevents it from starting until authorized again. Home's Start action starts all
authorized activities together.

The controls are independent. **Stop collection** stops new observations while
already collected activity remains eligible for processing. **Stop learning**
interrupts learning and keeps pending activity within its retention limit; it does
not stop collection. Proactive mode has its own control and can use existing
knowledge without new collection. **Delete pending** is a separate confirmed action
that removes queued activity and cancels its review. Deleting pending activity
does not delete saved memories. Starting collection does not resume explicitly
paused processing. Older settings that were off and have no processing
preference load with processing paused.

Choose a learning model explicitly. Proactive reviews can use that model or a
separate profile. Configure collection, learning and proactive activity hours
independently, with an explicit time zone. Learning can start on a time interval
or after an eligible observation count; an admitted pass drains in bounded batches.
Storage pressure can admit eligible work earlier, subject to the same hours,
pause and resource limits. Pending evidence expires after 24 hours. Interactive
requests take priority and can interrupt background work for later resumption.

Learning and proactive activity share persisted daily model-call and embedding
limits. Each actual model stage consumes a call; these limits are not monetary
or token budgets. Local or unclassified providers run one operation at a time;
known cloud operations can use the configured concurrency. No observation review
runs for an empty queue, although enabled proactive checks and due knowledge
reassessments can run independently.

The Companion listens for desktop accessibility events in the signed-in graphical
session. It collects settled visible text and editable-control changes across
applications, including documents, editors and browsers. Repeated content is
deduplicated; revisits retain a compact activity reference. Observations retain
their application/window identity and declared coverage, then enter bounded batches.
An editable control changing does not establish authorship, and a visible page
does not prove that the user read or agreed with it.

The selected profile's execution policy determines the review method. Execution
Agent profiles use a direct review. Supervisor profiles use bounded stages for
discovery, matching, decisions, authoring and assessment, with at most 18 stages
per learning review and four per proactive review. Each fresh stage calls the
model; replaying valid completed stages does not. Completed stages are saved
before the next call and can resume after pauses, resource deferrals or
restart while the evidence, knowledge and model bindings remain valid. Changed
or expired inputs invalidate saved progress. Neither method can invoke tools or
perform the suggested action.

Learning proposals use the shared automatic memory-admission policy described
above. Proactive reviews may deliver a suggestion to a conversation, decline to
send one, or schedule reconsideration. They respect independent activity hours,
daily message limits, current knowledge versions and duplicate-delivery controls.
Reading a delivered suggestion clears its unread Home presentation.

The Applications tab has separate collection and processing exclusions. A
processing exclusion retains pending observations under the existing expiry
limits; it does not retract content already sent to a provider or delete saved
memories. Previously collected activity remains explicitly deletable.

Before an observation leaves the Companion, supported credential labels and
recognizable secret formats trigger redaction of the entire affected text field
as `[REDACTED]`. This covers captured content, source metadata, URLs and diagnostic
reasons across applications. Surrounding ordinary text in that field is also
removed, which can reduce learning detail; other fields remain available.
Recognition uses a bounded rule set: unlabelled secrets and unknown formats or
encodings can still pass through. This protection applies to newly collected
observations after the updated Companion is running; existing stored observations
are unchanged.

Native reads are at least five seconds apart. A sustained sequence of non-edit
changes is muted after four reads within 30 seconds, before another accessibility
extraction. A foreground-window switch, an editable-control change or 30 seconds
without changes releases the mute. Quiet screens do not trigger periodic reads.
This limits noisy movie/game interfaces without identifying specific applications.

Stopping collection closes the native reader and its timers. The Companion's
connection remains available for Computer access; it watches connection-file
changes and checks private state every 15 seconds instead of every second.
Status writes replace a single bounded file and retain private-file permission
checks. This is maintenance, not screen collection or model execution.

The pending queue is capped at 256 observations and 2 MiB of serialized evidence;
the raw journal holds at most 50 batches within 4 MiB. These are data bounds,
not total process-RAM limits. Existing memory-store retention remains unchanged.

The current Companion excludes ABot's own Web UI by its canonical window title
before transport, including tabs left open with the previous canonical title.
This requires an updated Companion and an operating system that exposes the
window title; a hidden or rewritten title cannot be identified by this rule.
Previously saved memories and observation history are unchanged.

Windows uses UI Automation and window events. macOS uses Accessibility and a
Swift helper; the host needs its Swift toolchain and must grant Accessibility
permission. Linux uses a graphical session with Python AT-SPI, D-Bus and GLib
bindings and accessible session-lock status. Missing dependencies or permissions
are reported without installing software or escalating privileges. Wayland and
application accessibility coverage varies: protected controls, inaccessible
canvas content and unexposed document text remain missing, rather than being
presented as observed. The activity collector does not capture video, audio,
keystrokes, clipboard history or perform OCR.

For WSL, run the Companion on Windows. For Docker, run it on the native desktop
host. The Companion connects to the Runtime endpoint published or forwarded on
host loopback; the container or WSL process does not read the desktop itself.
The paired device grants one learning subscription at a time, so a second
environment cannot silently start duplicate collection. Connection leases stop
native collection when its authorized owner disconnects.

ABot Spark shows collection state, recent batches and bounded observation
detail. Memory shows saved records and their configuration. Home shows a compact
learning section while collection is enabled or unprocessed activity remains,
including disconnected, failed and paused-processing states.
These screens receive invalidation events
and fetch canonical state; they do not poll for screen data or create collectors.
Raw batch evidence is local, private runtime state with a bounded history and
24-hour expiry cleanup while the service runs and at startup. A stopped process
cannot execute cleanup until it starts again. The general model-I/O trace omits
learning payloads and model output; diagnostics retain identifiers, counts and
failure codes. The batch details view makes partial collection visible.

Connected Companions report a release number independently of the wire protocol.
ABot Spark offers setup again when that release is older than the Runtime's bundle
or was not reported by an older installation. The installer still verifies the
exact bundle and replacement process; a newer Companion is not downgraded by this
notice. Update through Computer access to replace the installed native bundle.

Native platform support must be verified on the target desktop and applications.
Fixture tests of the transport and collector scripts alone are not proof of
desktop coverage or the quality of learned memories.
