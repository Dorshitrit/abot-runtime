# abot Web UI

This is a local web client hosted from `abot`.

It is intentionally a client/transport layer only:

- By default, the UI talks directly to the local `abot` process.
- `LLM_RUNTIME_WEB_BACKEND=bridge` enables an external bridge proxy path.
- The web transport does not own sessions, request state, planner state, or
  replay state.
- Runtime core orchestration is not changed for the web UI.
- Existing external bridge clients remain unchanged.

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

Configuration saves hold the canonical Runtime-file lock while resolving and
writing linked model or request-runner files. The linked file keeps its own
revision check; another cooperating save cannot redirect the reference between
target resolution and commit.

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

## Workspace addresses

Home, Chat, Schedules, Notifications, Spark, Memory, Models, Plugins and System
have browser addresses at `/home`, `/chat`, `/schedules`, `/notifications`,
`/learning`, `/memory`, `/models`, `/plugins` and `/system`. Refresh restores the
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

## Notifications

The local backend exposes `/notifications` with a persistent inbox, unread
filter, read controls, source navigation and desktop preferences per event kind.
Bridge mode hides this workspace. The Web backend records completed agent replies
when no client is focused on their conversation, failures, pending approvals and
delivered Co-worker proposals. A cancelled request creates a reply only when the
runtime supplies its saved stopped-response text. Progress and reconnect replay
do not create records.

Browsers report the visible, focused chat through `notification_presence` frames.
Presence is scoped to the environment and conversation, renewed every 20 seconds
and expires after 60 seconds; socket close removes it immediately. Suppression
applies only to replies. Reading a notification does not mark conversation
messages read, and opening the inbox does not mark every notification read.

`notifications/` owns projection, persistence, HTTP routes and delivery. Records
are scoped by environment and configured sessions path under
`<runtimeDir>/web-ui/notifications/`. The store uses atomic writes, stable event
identities and cursor paging. History has no automatic retention deletion.
Preferences affect desktop delivery only. A stored notification precedes delivery;
pending records from an earlier process become unconfirmed on restart without
being resent. A native submission acknowledgment is not a display/read receipt.

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
