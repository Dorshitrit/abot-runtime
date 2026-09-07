# Web UI architecture

The browser client is intentionally framework-free, but it is not a single-layer script.

## Ownership

- `app.js` is the browser composition root. It creates the shared mutable state identity, locates root DOM nodes, and wires dependencies. It does not own HTTP payloads, WebSocket feature messages, conversation hydration, replay, approval presentation, composer submission, queue, attachment, session-list, runtime-selection, or Operations behavior.
- `services/` owns browser infrastructure: Runtime HTTP calls, realtime transport, and persisted client preferences. Services receive configuration through factories and do not import controllers or components.
- `controllers/` owns cohesive stateful workflows. Session lists, realtime event reduction, composer attachments and queues, steering, runtime/model selection, Operations loading, and DOM event binding each have one controller boundary. Controllers receive state, services, presentation callbacks, and DOM references explicitly.
- `components/` owns reusable browser presentation and focused interaction controls. Components receive DOM elements and callbacks; they do not import application state or call Runtime endpoints. A component may compose lower-level components, but component dependencies must remain acyclic.
- `lib/` owns deterministic presentation and formatting. Library modules do not mutate application state.
- `ui-behavior.js` contains small deterministic interaction policies that are covered by Vitest.

Dependencies flow in one direction:

`app.js -> controllers / services / components -> lib / ui-behavior`

Controllers and components communicate through injected callbacks or values. They must not reach back into `app.js`; services must not depend on controllers or presentation code.

`workspace-shell.js` is the single owner of workspace navigation. It owns the active Home, Chat, Schedules or Config workspace, responsive Conversations visibility, focus restoration, Escape handling, backdrop state, and related ARIA attributes. `conversation-sidebar-layout.js` resolves the sidebar presentation policy; `operations-section.js` owns the internal Runtime, Logs, and Health tabs within Configuration. These components must not own session data, request state, or Runtime transport.

`conversation-activity.js` owns only request-scoped activity presentation. `realtime-event-controller.js` preserves sequence authority, associates events and progress with their exact `requestId`, and injects those values into the conversation view. `realtime-transport.js` only parses and transports frames; it does not reduce application state.

`composer-context-window.js` presents the existing context estimate as one compact composer indicator. It selects the active assistant request, or the newest conversation message only when it is a request-linked assistant message while idle. A pending user turn, an assistant message without a request ID, or missing metrics hides the indicator instead of falling back to an earlier request. Context metric updates refresh it independently of message tokens; session-view resets clear it. Estimated usage, provider-reported usage, and compaction remain distinct, and provider usage stays bound to the matching model invocation.

`composer-plan.js` presents the current user turn's Planner plan in a collapsed-by-default drawer above the composer. `composer-plan-model.js` selects request-linked progress from the current turn, including restored failed requests that have only a persisted user message; a new user turn hides earlier plans. Disclosure identity follows the selected request, so steering preserves expansion and list scroll; session resets clear the drawer. `task-progress.js` reduces structured plan events by request: full snapshots replace the baseline, later item changes are retained across overlapping replay, and completion counters never imply request or Reviewer success. Live events and stored replay use this same projection. Historical per-response progress remains available in Activity.

Activity counts tool invocations from `tool.started` entries and their recorded multiplicities before timeline display grouping. Completion, payload, and approval events contribute to action details but do not add tool invocations; terminal-only history does not invent missing starts. Failure-event counts retain their existing meaning.

Tool activity is presented as one evolving action per `(requestId, executionId)`.
`tool-activity-event.js` retains only bounded display fields; `tool-activity-model.js`
combines payload, approval, execution, and outcome events without guessing from
tool names or event adjacency. `conversation-tools.js` renders compact disclosures
inside the executing agent's card, preserving expansion and scroll across updates.
The canonical role call supplies `executorRole` and `roleCallId`; explicit identity
takes precedence over the currently active role, including late completions.
Older events use the recorded role-stage association when available. Actions
without recorded ownership appear in an explicitly unattributed card.
Prepared input is distinguished from input sent to an executed tool. Source
truncation and preview clipping remain separate, and an absent outcome never
implies success. Existing uncorrelated history supplies independent outcome rows;
unpaired legacy progress stays in the diagnostic timeline. Live and stored events
use the same projection. Raw lifecycle events remain stored for replay and counts.

Plugins may declare `eventPresentation.resultMetadata` to select bounded previews
or scalar facts from existing tool results. This projection is evaluated only at
the completion-event boundary: tool output, canonical evidence and model context
are unchanged. The Web UI does not fetch a file or memory record again to recreate
historical evidence. Passive Runtime memory remains outside tool activity.

Web sources appear in a separate Activity section alongside role cards and the event timeline. `web-source-event.js` projects only successful `web_search` and `web_fetch` completions; `web-sources.js` validates bounded plugin receipts and groups them by recorded call. `conversation-sources.js` renders links and retrieval/presentation states without interpreting answer text. Source-bearing events retain their own identity before display grouping, and stored session events use the same projection as live events. Session switching clears them with the existing Activity state.

The optional `meta.webSources` version 1 receipt describes the final bounded **tool output**, not whether a later model invocation consumed or cited it. Older events can show found/fetched URLs with unknown output visibility; absent or unsupported receipts never imply full content. Favicons are best-effort browser requests to the source origin's `/favicon.ico`, loaded lazily with no referrer and a local fallback. No third-party icon service or server proxy is used. Source URL policy rejects unsafe schemes and credentials, and prevents automatic image loads for local/private IP literals; origin DNS, redirects, cookies, and browser image policy remain browser concerns. Icons carry no evidence and never block tool execution.

`conversation-session-controller.js` is the single owner of the active conversation view lifecycle: normalized message identity, session switching, stored-message hydration, request-event replay, read state, active assistant placeholders, and session/request realtime subscriptions. `chat-request-controller.js` owns starting one chat request, while `composer-submit-controller.js` owns the composer's selected action and busy/error lifecycle. `tool-approval-controller.js` owns approval state and transport; `tool-approval-card.js` owns its DOM presentation.

The primary information architecture starts at Home:

- the navigation rail is persistent;
- Home, Chat, Schedules and Config are mutually exclusive workspaces;
- Conversations is docked beside Chat from 1260 CSS pixels upward, with its own column and no modal backdrop;
- below that width, Conversations is the only transient sheet and overlays the chat canvas;
- Configuration always hides Conversations and uses the full content canvas;
- request tools, progress, and failures remain attached to the corresponding assistant response;
- Configuration contains one Operations section with the existing Runtime, Logs, and Health views;
- the Operations section is a static sibling of the generated configuration dashboard, so dashboard rerenders cannot detach its controls or status nodes;
- internal Operations tab changes preserve configuration drafts; leaving Configuration remains guarded by the explicit discard check.

Panel resizing and persisted panel widths are intentionally not part of this architecture. Crossing the sidebar breakpoint closes transient drawer state and restores focus when its previous target becomes hidden.

`dashboard-feature.js` composes Home presentation and data refresh. Its controller reuses the canonical conversation list and bounded scheduler run history, refreshing while Home is visible. Recent conversations retain all unread conversations and fill remaining slots with recently updated read conversations. Run activity follows the scheduler's scheduled-time ordering. Loading, failures, and empty states remain distinct.

`composer-workspace-controller.js` moves the existing composer DOM between Home and Chat and isolates their draft text and attachments. `composer-surface-controller.js` routes input, rendering and attachment actions to the active surface. Both surfaces use the same attachment and submission controllers; background Chat queue work writes to its own input surface. Home submission adopts its draft into a new conversation before invoking the ordinary Chat request controller. Home navigation alone never resets or reads the active conversation. `conversation-read-state-controller.js` rechecks visible Chat, environment, session and view revision before marking persisted assistant messages read.

Dashboard Job suggestions are inert data in `dashboard-job-templates.js`. They open the ordinary schedule form with editable defaults, a selected model, device time zone and a new dedicated conversation target. Only explicit Save creates state. `schedule-job-creation.ts` adapts this Web-only target into an owner-created conversation and the existing scheduler contract; it never invokes the model. Existing-conversation creation remains supported. `configuration-feature.js` owns the composition of Configuration and its memory controls. `app-bootstrap.js` owns startup ordering, environment restoration, initial loading and Home activation.

Read tracking belongs only to the native Web UI backend. `session-read-state/service.ts` reads canonical session snapshots and projects unread assistant replies; `store.ts` persists the UI cursors in an environment-specific sidecar under `runtimeDir/web-ui/read-state/`. Runtime session files, model context and Runtime contracts remain unchanged. A persisted initialization timestamp treats existing history as read and tracks later replies, including newly created Job conversations. Read acknowledgements resolve only the displayed persisted assistant message or its exact completed request ID. Cursors advance monotonically and survive server restarts; invalid boundaries never acknowledge unseen replies. Browser consumers retain newer read revisions when older responses arrive late.

The native conversation list uses the existing `SessionService` disk reader and canonical client-visible projections once per refresh. It avoids offset pagination over changing conversation order and avoids sending all request-event histories through the managed Runtime RPC. Only Web UI read-state sidecars are written by this projection. Clearing messages keeps a fresh read revision so subsequent unread replies can replace the previous read receipt.

Read-state persistence is an optional Web UI projection. `session-read-state/availability.ts` isolates sidecar failures from listing, loading, clearing and deleting conversations. A failure returns `readStateStatus: "unavailable"` and unknown counts, preserves the sidecar for diagnosis, and leaves read acknowledgements unsuccessful. The browser keeps the last known receipt, labels unavailable tracking explicitly and resumes normal counts after a healthy list refresh. Canonical session and attachment failures remain errors. Workspace visibility is committed before change callbacks attempt to acknowledge visible messages, including drawer closure and responsive layout changes.

## Styles

`styles.css` is the ordered manifest. The modules under `styles/` own:

1. structural foundation and compatibility rules;
2. design tokens and common controls;
3. shell and conversation navigation;
4. chat and composer presentation;
5. inspector and configuration workspaces;
6. responsive behavior.

Keep responsive overrides last and avoid moving declarations between modules without checking the desktop, tablet, and mobile layouts.

## Contract boundary

Visual components may format or group events, but they never accept transport frames or construct Runtime API payloads. Realtime frame parsing belongs to `realtime-transport.js`; request sequence and terminal-state reduction belong to `realtime-event-controller.js`; endpoint construction and HTTP payload serialization belong to `runtime-web-client.js` and its feature request modules; and feature controllers own when those operations occur. Config remains explicit-save; presentation changes must never introduce autosave.


## Core schedules

`schedules-feature.js` composes the scheduler browser feature from its controller,
transport requests and presentation. `schedules-controller.js` owns loading and
management actions scoped to the selected environment, guards stale reads, and
refreshes only while the workspace is active and no editor or mutation is pending.
The full Schedules workspace shares the shell navigation and discard guards;
its editor uses an explicit save and a saved model/mode with Full tool access.
Unchanged timing fields are omitted from edits, preserving the original timer or
interval anchor when only a title, prompt or model changes.

`workspace-state.js` owns the single page-level loading, empty, missing or failed
read presentation before any schedules are available. Loaded jobs and unsaved
editors remain visible if a later request fails. `schedule-errors.js` maps service
error reasons to display text without changing the management or domain contract.
The schedule workspace owns its full-width alignment; it does not inherit the
configuration page's centered child-width caps.

`conversation-schedule.js` presents the persisted invocation as a compact Job/Run
reference. Its prompt disclosure reads that canonical message's exact historical
content; it does not fetch the current Job to reconstruct an earlier request.
The normal assistant reply remains separate. `schedule-realtime.js` admits only
`schedule.triggered` events with exact environment, session, request, message and
run identity before activating the ordinary realtime request lifecycle. Duplicate
trigger delivery cannot add another user message or reactivate a completed run.
The scheduler page and chat card are presentation-only consumers; the runtime
scheduler remains the sole owner of Job state and dispatch decisions.
