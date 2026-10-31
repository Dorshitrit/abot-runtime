# abot Web UI

This is a local web client hosted from `abot`.

It is intentionally a client/transport layer only:

- By default, the UI talks directly to the local `abot` process.
- `LLM_RUNTIME_WEB_BACKEND=bridge` enables an external bridge proxy path.
- The web transport does not own sessions, request state, planner state, or
  replay state.
- Runtime core orchestration is not changed for the web UI.
- Existing external bridge clients remain unchanged.

The local conversation list reads the session layer's persisted `.metadata/`
index. Each session has its own atomically replaced projection: list fields and
visible message identities/timestamps for unread counts, without transcript or
request-event bodies. Message changes update only that session's projection;
request-only events update a small `.json.source` receipt binding the new source
stamp and activity time to the unchanged projection. They do not scan or rewrite
the message metadata, in either legacy streaming or durable lifecycle events.
Read cursors remain in the existing Web UI store. Session JSON remains canonical.

Existing sessions are indexed on the first list read that needs them. A complete
projection is its own backfill receipt, so restarts and interrupted backfills
reuse completed entries. Source file stamps detect missing/stale projections,
including a crash after the session commit, and rebuild only those entries.
Listing reads at most four entries concurrently, including the initial backfill.
Projection publication and deletion share a per-session file lock, including
backfills in a separate process; source stamps are checked again before rename.
Index failures do not reverse successful session commits or prevent listing a
readable canonical session, and emit a `SESSION_METADATA_WRITE_FAILED` warning.
An unavailable index may require rereading that session until it is writable.
The list still enumerates all session
metadata; pagination and changes to message/event loading are separate work.

Opening an active conversation supplies its known session identity when reading
request events and resuming the display. The session store verifies the request
belongs to that session before returning replay; older callers without a usable
hint still resolve by request identity while reading one session at a time.
Overlapping reads share only in-flight raw file I/O, with access checks and event
cursor projection applied separately for each caller. Later reads see fresh
storage. Approval reattachment uses the replay's verified session identity, so
refreshing an active conversation does not enumerate unrelated approval waits.
This read path never starts, resumes execution of, or steers a model request.

The context indicator describes the latest measured model attempt in the
selected request, including its step and profile. Input count, percentage and
remaining capacity use the same valid provider measurement, or an explicitly
labelled estimate when no valid measurement is available. A rejected attempt
can still have a measurement; the indicator does not establish model execution.
Provider usage is a separate fact associated with the same invocation.
Compaction status and before/after details come from that invocation's lifecycle
events. A smaller snapshot or a different model step cannot complete a cycle.
Live events and trusted session replay use the same scoped state reducer.

Native schedules are available only with the local Runtime backend. The browser
uses the existing `/web-config` backend identity to expose the Schedules
workspace after bootstrap. Bridge mode hides its navigation and blocks schedule
requests locally; historical schedule cards still show their saved content,
with the Job navigation disabled. There is no scheduling adapter for the
external bridge.

Run history shows one newest-first page at a time, with Newest, Newer and Older
navigation. Refresh and server change events keep the current page; selecting a
different Job or environment starts at the newest page. The HTTP endpoint
defaults to 50 runs and accepts a maximum page size of 100, with a Job-scoped
cursor for older records. The owner query is bounded before local RPC transfer;
each returned record retains its complete prompt, result and execution details.

The local backend starts configured environments independently, so a slow or
unavailable owner cannot delay another environment's schedules. Shutdown awaits
the startup aggregate before stopping every created environment.

Apply only replaces Runtime owners while they are idle. If gateway activation
or replacement startup fails after those owners close, it restores the previous
owned gateway's in-memory policy and recreates the previous environments from
their applied configuration. Saved edits remain on disk for a later explicit
Apply. A failed restoration is reported as unavailable, and shutdown never
restarts a gateway or environment during rollback.

A model step reaching its Runtime timeout shows a dismissible suggestion in the
current conversation. **Double & restart** saves twice the recorded limit for
that model's specific calibration step, then uses the existing idle-only Apply.
If work is still active, the change stays saved and Restart can be requested
later. Shared or changed configuration targets open Model settings instead of
being changed automatically. Network errors and user cancellation do not trigger
the suggestion; it does not replace the agent's response or retry its request.

An external local gateway is retained when its effective configuration inputs
are unchanged from every active Runtime environment's startup snapshot. Plugin
selection alone does not require replacing that gateway. Changed model policy,
linked runner model defaults, gateway address or logging still require the
external gateway's configuration to be applied separately. Unknown snapshots
(including custom provider adapters) retain the existing restart requirement.
Snapshots follow successfully applied environments and their rollback; this
comparison does not inspect the external gateway's live policy or claim ownership.
Plugin changes still require all Runtime owners to be idle and owned by this Web UI.

Configuration saves hold the canonical Runtime-file lock while resolving and
writing linked model or request-runner files. The linked file keeps its own
revision check; another cooperating save cannot redirect the reference between
target resolution and commit.

Completing onboarding starts a fresh model-catalog read even when an earlier
read is pending. Older catalog results and superseded refresh failures cannot
replace the current environment's availability. Manual checks still coalesce
while a check is in progress.

A successful onboarding Embedding save enables native memory and disables the
separate Memory plugin in the same revision-checked configuration write. Failed
probes, cancelled saves and skipped setup leave plugin selection unchanged.
Stored plugin data is retained, and the Plugins step reloads the saved selection
when revisited. Other Memory settings and CLI configuration keep their existing
plugin policy.

Memory → Setup also offers **Add connection**, using the shared embedding form
without restarting first-run onboarding. Its `/runtime/memory/connection`
endpoint reuses connection persistence and the ordinary memory onboarding
service, preserving the memory plugin policy, profile and event settings.
Partial saves return the existing safe provider receipt for retry. The dialog
holds configuration mutation ownership through canonical refresh, discards
stale environment results and applies saved settings only on explicit action.

Memory → Setup shows saved embedding profiles as selectable cards.
**New profile → Save profile** stores a named provider/model choice without
probing, changing the active memory binding, or copying credentials. Separate
connection IDs keep the same model on Ollama and llama.cpp distinct.
Selecting a card only selects its saved settings; **Test & enable memory**
probes that exact profile and saves the memory binding after success. Applying
the configuration remains a separate explicit action. Saved profile options and
embedding-fingerprint compatibility checks are retained.
**Remove** deletes only the selected saved definition after inline confirmation;
it never deletes connections or stored memories. The profile configured for
memory is protected, including while memory is disabled. Choose another memory
profile before removing it.

When a scheduled request finishes outside the displayed conversation, its
correlated terminal event refreshes the session list from the backend. The
sidebar receives the saved preview and unread state without selecting that
conversation, changing the active request, or marking its answer as read.
Environment checks and the existing session-list read guards discard stale
updates; event payloads never recreate deleted conversations.
The local scheduled-event publisher marks terminal events with
`requestOrigin: "schedule"`. A browser that connects after the run starts can
therefore refresh from its explicit environment, session and request identity,
even without the earlier trigger. This marker carries no activation prompt and
does not synthesize a chat message or replay an action.

## Live workspace updates

Home and Schedules fetch on entry, runtime readiness, visibility return and
WebSocket connection, then refresh on relevant server events. They do not poll
APIs on a recurring timer. Bursts are coalesced; a change received during a read
causes a follow-up read. Hidden or inactive workspaces reconcile on return.
Unchanged regions retain their DOM; updated regions preserve focus, disclosures
and scroll positions.

The scheduler publishes `scheduler.changed` only after a committed store change,
including terminal run history. Read-only and no-op scheduler ticks are silent.
The Web backend publishes environment-scoped `workspace_changed` frames for
approval registration/removal and session read/clear/delete operations. Home can
fetch and approve another conversation's action without opening or marking it
read. Web requests persist pure approval waits with their conversation and release
live execution resources. Compatible waits survive Runtime restart and resume
the prepared action only after an explicit decision. Duplicate or stale decisions
cannot dispatch a different activation, and cancellation remains available.
New messages and Jobs in that conversation wait until the request resumes or is
cancelled. Incompatible continuations remain pending and cancellable; persisted
activity events alone never authorize execution.
Persisted user messages and steering updates emit `session.messages.updated`.
Delete failures also invalidate because cleanup can fail after deletion commits.
These frames invalidate projections; they never recreate sessions or pending
approvals from event history and never appear as conversation activity.

## ABot Studio editing and reports

Timeline cards expose a compact step preview. Editing opens a body-mounted modal
with its own reading width, focus boundary and unsaved-change guard. The configured
tool and operation remain distinct from the user-authored step title. Zoom is
locked while a card or its editor is open; closing the card restores it.
Previous/next controls follow the current workflow order and guard
unsaved edits before switching steps. Tool input fields use the catalog's declared
types and bounds, including individual list items. Switching input sources keeps
the typed draft and schema; unsupported saved values remain visible for repair.

Step changes and workflow moves save directly to the draft; general settings use
Save draft. Undo move keeps up to 20 revision-guarded inverse moves during the
current session, including leaving and reopening the automation. Another edit or
an external draft revision invalidates that history. Reset draft to published
requires confirmation and creates a new draft revision from the displayed
published revision; publication, schedules, permissions and run records stay
unchanged. Both draft and published revisions are checked atomically.

Saved runs lead with retained final-step outputs. Markdown and structured values
are rendered through the shared safe text renderer; raw output, input bindings,
tool receipts and configuration are secondary disclosures. The selected-step
reader keeps a stable height. Same-run refreshes preserve the workspace scroll
and disclosures; selecting another step resets only that reader's scroll.
Execution status is separate from the saved content's claims. The UI does not
infer publication or file creation from model-authored JSON keys or text.

Studio run history reads 50 metadata rows per page through the scheduler cursor.
Status and inclusive local calendar-date filters apply on the server to the full
history using `scheduledAt`, before the page limit. Scrolling near the list end
loads the next page; Load more offers the same action for keyboard users. Newest
reloads the first page with the current filters. Selecting a run reads its saved
report separately and does not reset the history. While browsing older pages,
background updates keep the selected report current without replacing the list;
Newest refreshes that history snapshot. Run and Run again also reload the first
page with the current filters before opening the created report. Failed page
loads keep the existing rows and cursor for an explicit retry; a history refresh
failure does not prevent opening the created report. Report retention policy is unchanged.

## Workspace addresses

Home, Chat, Schedules, Notifications, Spark, Memory, Skills, Models, Plugins and System
have browser addresses at `/home`, `/chat`, `/schedules`, `/notifications`,
`/learning`, `/memory`, `/skills`, `/models`, `/plugins` and `/system`. Refresh restores the
addressed workspace, and browser Back and Forward follow accepted navigation.
`/` starts at Home. Legacy `/config` addresses map to the current workspace.

The address includes the configured `environment`. Chat adds its `session`;
System adds its Operations `tab`; Schedules adds the selected saved `job`.
For example, `/system?environment=dev&tab=logs` restores System's Logs view.
These addresses use the existing static app fallback.
They do not save drafts or perform configuration, schedule, or approval actions.

Restore validates environment and conversation identities against the current
catalog and list. Workspace availability and the existing configuration,
schedule-draft, and queue guards also apply to browser navigation. Declining a
transition keeps the accepted view and address. An unavailable environment never
redirects its conversation or Job identifier into another environment.

## Personal Skills

The local Runtime backend exposes `/skills` for personal Skills created with the
model or entered manually with New Skill. Creation requires a name, short
description and content; the Store generates the ID. The workspace has
active/archive lists and loads the selected content on demand. Name, ID and description are read-only; only active content is editable.
Archive removes a Skill from new model discovery and reads, while keeping it
viewable and restorable here. Built-in Skills are excluded. Existing captured
Skill evidence in conversations remains unchanged.

GET `/web-api/runtime/skills` lists personal metadata; POST creates from
`{name, description, content}`. `/:id` reads a document or
PATCHes `{content, expectedRevision}`. POST `/:id/archive` and `/:id/restore`
require `expectedRevision`. Writes use the existing same-origin JSON guard and
return the saved document; stale revisions return a conflict without replacing
the browser draft. All operations use the selected environment's Runtime owner
and existing Store; the Web server does not open a second repository. Navigation
and environment changes protect unsaved content, and late responses from an old
environment cannot replace the current editor. Bridge mode hides this workspace.
No renaming of saved Skills, deletion, import or export is added.

## Notifications

The local backend exposes `/notifications` with a persistent inbox, unread
filter, read controls, source navigation and desktop preferences per event kind.
Bridge mode hides this workspace. The Web backend records completed agent replies
when no client is focused on their conversation, failures, pending approvals and
delivered Co-worker proposals. A cancelled request creates a reply only when the
runtime supplies its saved stopped-response text. Progress and reconnect replay
do not create records. The browser tab favicon shows an orange dot while the
selected environment has unread notifications, including updates received while
the tab is in the background. Reading notifications clears the dot when the
shared unread count reaches zero; focusing the tab alone does not mark them read.

Browsers report the visible, focused chat through `notification_presence` frames.
Presence is scoped to the environment and conversation, renewed every 20 seconds
and expires after 60 seconds; socket close removes it immediately. Suppression
applies only to replies. Reading a notification does not mark conversation
messages read, and opening the inbox does not mark every notification read.

`notifications/` owns projection, persistence, HTTP routes and delivery. Records
are scoped by environment and configured sessions path under
`<runtimeDir>/web-ui/notifications/`. The store uses atomic writes, stable event
identities and cursor paging. History is bounded to 1,000 records and 90 days per
store. Every store access applies expiry; insertion also enforces the count cap,
evicting the oldest read records before unread records. Pending delivery and
manual unread records have no retention exemption. Up to 1,000 removed identities
are retained for 90 days to suppress recent duplicate delivery; retries do not
extend these receipts, and deduplication is intentionally bounded to that window.
Preferences affect desktop delivery only. A stored notification precedes delivery;
pending records from an earlier process become unconfirmed on restart without
being resent. A native submission acknowledgment is not a display/read receipt.

Committed conversation read receipts synchronize matching reply notifications.
Ordinary chat uses its existing cumulative read boundary; SPARK uses exact visible
message receipts. The shared Web read-state owner verifies current message
identities without modifying session messages or events. Synchronization runs
after a successful read, when listing notifications, and when a reply arrives
later. An accepted tool approval or rejection marks its exact approval notification
read, through the shared HTTP/WebSocket decision owner. Duplicate or rejected
commands do not change notification state. Viewing a loaded automation run report
in Studio or chat marks that run's observed phases read: an active report covers
only the start, while a terminal report covers both start and finish. Hidden
reports, run lists and background fetches do not count as viewing. Environment and
run identities remain isolated. Private source-read receipts cover delayed event
insertion and survive restart, bounded to 1,000 identities and 90 days. An explicit
Mark unread remains authoritative until another explicit read/source action or
retention expiry; repeated rendering of the same report phase is not a new action.
Because old storage did not distinguish manual unread, the first access
protects all retained legacy unread records; automatic synchronization starts
with newly created notifications. Private override and deduplication metadata
remain bounded and are not added to the HTTP notification representation.

Desktop delivery uses the existing authenticated Computer access connection and
the `desktop_notifications_v1` capability. It is a transport operation, unavailable
as a model tool. The native companion resolves source links against its paired
runtime origin, preserving WSL/Docker host ports. Browser availability does not
control delivery, but the Runtime Web backend and the graphical host companion
must remain running. See [installation](../../docs/installation.md#notifications)
for platform requirements and notification permissions.

## Message content

User and assistant messages render CommonMark Markdown with tables, nested
lists, emphasis, quotes, code blocks, and automatic clickable URLs. HTML in
messages stays literal. Code stays literal and is not collected for previews.
The browser parser is bundled locally under `app/vendor/`.

Completed messages show up to three unique compact link cards. Visible cards
load public-page title, description, and thumbnail metadata through the Web UI
server; full details are available in the card tooltip. Streaming messages wait
until completion. The preview caches are bounded, temporary, and deduplicate
repeated renders. Sites without available metadata retain a clickable title and
domain. Remote Markdown image URLs use the same preview path.

Preview fetching is independent of Runtime requests and tool-source receipts.
The shared public HTTP transport validates DNS and redirects, pins the resolved
public address, and limits response sizes and time. Thumbnail images use an
opaque same-origin proxy with raster validation. The preview endpoint works
with both the local Runtime backend and the external bridge backend.

## Work timeline

Conversation activity uses one chronological timeline above the final answer.
EA progress messages and SUPER acknowledgement/tool intent are interleaved with
recorded actions using event ordering, without changing model execution.
Acknowledgement is explicitly tagged; unmarked reasoning is not promoted into
progress prose. Tool rows retain their status icons, keyboard disclosures and
file actions, without a visible status suffix or disclosure arrow. Source,
memory, role and delegation evidence remain available inside the timeline.
The timeline stays open while working or waiting for approval and collapses
when a completed final answer is shown. Show timeline reopens it; subsequent
renders preserve the user's choice. Failed/stopped runs keep their activity
visible. SPARK shows only ongoing EA updates and the final answer in its assistant
transcript, using the shared progress-message style. Other events stay hidden;
actionable approval cards remain separate from the transcript.

## Files in conversation activity

With the local Runtime backend, successful filesystem writes and edits can make
the filename inside the tool activity summary clickable. Clicking it opens the
current file in the conversation viewer; the activity's sent/received fields and
edit excerpt remain the historical record. Opening or closing the viewer does not invoke a model or tool.

The viewer supports UTF-8 text and code, safe Markdown, and PNG/JPEG/WebP images.
Text previews stop at 256 KiB; images stop at 10 MiB. HTML and SVG remain source
text. Other formats show a preview-unavailable state. The desktop viewer sits
beside the conversation and becomes an overlay on smaller screens. It closes when leaving the conversation.

On macOS, **Open on Mac** opens the original document/image in its default app.
The button is available only for supported non-executable file types through a
local Web UI connection. It replaces the overflow menu and invokes no model.
A same-origin JSON POST carries only conversation identifiers; the server
revalidates the request generation, completion and opened file before invoking
`/usr/bin/open` without a shell. The external app resolves the original pathname
asynchronously, so its read is not covered by the viewer's held-file guarantee.
An opener error leaves the viewer usable and displays inline feedback. The
existing bounded download API remains available for client compatibility.

Only a recorded successful mutation with an explicit file origin can expose the
action. Older events, read operations and unchanged writes do not infer file
outputs from paths or assistant text. The server resolves the recorded origin
inside its original configured root. A deleted file, unavailable conversation or
changed root is reported as unavailable; it is never replaced by a same-name
file elsewhere. Existing uploaded attachments retain their separate lifecycle.

The mutation reports its actual root directory identity while that directory
handle is still open. If the configured root has been replaced by the time the
host receives the report, the completion does not gain a file action.

Each root's first presented mutation creates a small hidden
`.abot-file-output-root` identity marker without overwriting a colliding file.
The marker and directory creation identity keep an older action from opening a
replacement root at the same pathname. Preview never creates or repairs markers.
Deleting the marker invalidates earlier actions; a later successful mutation can
establish a new identity. Old path-only receipts and filesystems without stable
directory birth identity cannot expose file contents through this feature.

File access also requires the original request generation, created only by an
explicit request start. Clearing or deleting a conversation removes that
identity; late persisted events and steering cannot restore it. The server
rechecks the generation and completion after reading, before returning bytes.
Legacy records remain readable as chat history but do not gain file access.

## Project changes in chat

Expanding a successful file action loads its current changes against Git HEAD
in the returned-preview area. When available, a unified diff with fixed green/red
colors and additions/deletions counts replaces the plain excerpt automatically,
without a second disclosure button. Without Git or an available diff, the
existing returned excerpt remains unchanged. This is the file's current Git
state, not a historical diff of that particular tool execution. Recorded
messages and events stay unchanged.

A project-wide file list and diff also open automatically beside the conversation
when the viewport is at least 1800 CSS pixels wide and changes are found. There
is no global changes button below the final answer. Normal-width windows use the
inline operation preview. Initial checking and empty results remain silent;
explicit file previews retain priority over the automatic project panel. The
feature is shared by EA and SUPER, without model calls or model-context changes.

The local backend derives the directory from the saved conversation's project
binding. Results are limited to that subtree, even when the Git root is an
ancestor. The comparison includes staged/unstaged changes and untracked files
against HEAD; an unborn repository uses an empty base. Renames may appear as
deletion and addition. Ignored files and nested submodule contents are excluded.
The exact project-root `.abot-file-output-root` marker is excluded from diff
content and file/line totals; its file and identity checks remain unchanged.
Other files, including similar names or nested names, are not hidden by this rule.

GET `/web-api/chat/project-changes` accepts only environment and session IDs.
GET `/web-api/chat/project-changes/file` additionally accepts a server-provided
file ID and revision. GET `/web-api/chat/project-changes/operation` accepts
request/execution IDs and binds the file through its recorded successful output,
request generation and current project-root identity. Browser paths and Git refs
are never filesystem authority. Changed sources require a refresh.

Git commands run without a shell, with bounded time/output and no optional index
writes. Git supplies metadata/raw blobs; bounded local comparison and standard
text/EOL normalization produce previews without invoking external diff, textconv,
clean or process commands. Repositories with configured clean/process filters or
partial-clone fetching are unavailable in this version. Binary, oversized and
unsupported transforms have explicit preview states. The file list is capped at
200; incomplete line totals stay unknown.

This version supports projects on the Runtime host with Git installed. Bridge,
Companion-only roots and workspace output receipts outside the project binding
are not supported. Conversation/environment changes cancel pending previews.
The feature does not stage, revert, commit or modify files or Git state.

## Run

```bash
npm run web-ui
```

Open:

```text
http://127.0.0.1:5177
```

## Configuration

Optional environment variables:

```text
LLM_RUNTIME_WEB_HOST=127.0.0.1
LLM_RUNTIME_WEB_PORT=5177
LLM_RUNTIME_WEB_BACKEND=runtime
LLM_RUNTIME_WEB_ENVIRONMENT=<optional default profile id>
```

The Web UI accepts requests addressed to its configured hostname or the
connected local interface IP, using the actual listener port. Loopback
connections also accept `localhost` and loopback IP aliases. Binding to
`0.0.0.0` or `::` permits direct LAN IP access; it does not trust arbitrary
DNS hostnames. Unknown Host headers are rejected before HTTP or WebSocket
dispatch, including when Origin matches. Forwarded headers do not establish
trust, and reverse-proxy aliases are not configured by this policy. This is
a request-authority check, not authentication for clients on an exposed LAN.

The direct runtime backend uses the active runtime config and environment
profiles. The environment picker is populated from
`environment.profiles` in the runtime config, and defaults to
`environment.default` unless `LLM_RUNTIME_WEB_ENVIRONMENT` is set. The UI sends
chat requests to the runtime in-process and receives request events over
`/web-realtime`.

## Local backend architecture

`local-runtime-backend.ts` is the stable composition facade used by the Web UI
server. Cohesive owners under `local-runtime/` implement the boundary behind
that facade: `api-router.ts` dispatches routes, `request-execution.ts` owns chat
request startup, `realtime-controller.ts` and `realtime-hub.ts` own WebSocket
control and event fan-out, and the attachment and control route modules own
their corresponding HTTP endpoints. The facade wires these modules to the
Runtime dependencies; route owners do not reach back into the server or one
another.

The browser entrypoint follows the same ownership rule. `app/app.js` only
composes shared state and collaborators. `app/services/runtime-web-client.js`
owns HTTP routes and payload serialization; conversation hydration and replay,
chat submission, composer dispatch, and approval presentation each have a
focused controller or component under `app/controllers/` and `app/components/`.

### Open automatically with the PROD Runtime service

The optional WSL user-service integration starts this Web UI and opens it in
the WSLg browser only when `llm-runtime.service` starts. It is deliberately not
attached to `llm-runtime-dev.service`.

Enable the behavior in `runtime.config.json`:

```json
{
  "webUi": {
    "openOnRuntimeServiceStart": true
  }
}
```

Install or refresh the versioned user units without starting or restarting any
service:

```bash
npm run web-ui:install-user-services
```

The units take effect on the next `llm-runtime.service` activation. Browser or
readiness failures are logged but never fail the Runtime service.

To use an external bridge, set:

```text
LLM_RUNTIME_WEB_BACKEND=bridge
LLM_RUNTIME_WEB_API_BASE_URL=http://127.0.0.1:8787/abot/api
LLM_RUNTIME_WEB_REALTIME_URL=ws://127.0.0.1:8787/abot/realtime
LLM_RUNTIME_WEB_HEALTH_URL=http://127.0.0.1:8787/abot/health
LLM_RUNTIME_WEB_AGENT_MODE_URL=http://127.0.0.1:8787/abot/agent-mode
LLM_RUNTIME_WEB_API_TOKEN=<chat api token>
```

If `LLM_RUNTIME_WEB_API_TOKEN` is omitted, public endpoints such as
`/chat/models` can still work, but protected session/runtime/admin endpoints
need a token. The web server resolves it in this order:

1. `LLM_RUNTIME_WEB_API_TOKEN`
2. `CHAT_API_AUTH_TOKEN`
3. `CHAT_HISTORY_API_TOKEN`
   The web server does not read adjacent application or bridge project files.
   Production bridge URLs and tokens must be provided explicitly through the
   environment.

## Information basket

The local Runtime backend exposes Resources at `/resources`. The personal basket
is available across chats in the selected Runtime environment. Its sources remain
at their original filesystem paths; this workspace never uploads or copies files.
The Runtime picker returns actual host paths. External browser drops retain only
filenames in the current view until the user explicitly links their source paths.

The table shows canonical indexing status, source metadata and last indexing time.
Search and status filters are local projections. Re-index and removal carry the
observed source revision; removal deletes only the basket registration. Embedding
profile and enable changes use explicit Save settings and a settings revision.
Supported formats come from the basket service. No conversation identity is saved
in the Resources address.

Committed `workspace_changed` invalidations for `information-basket` refresh the
active visible workspace. Bursts coalesce, and reconnect, visibility return and
accepted environment changes reconcile through a fresh service read. Stale reads
and mutations cannot update another environment. The external bridge has no
basket management adapter.
