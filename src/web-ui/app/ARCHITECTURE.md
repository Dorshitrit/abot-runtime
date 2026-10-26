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

`workspace-route-controller.js` owns the browser address projection and history
restoration; `lib/workspace-route.js` owns address parsing and serialization.
The four workspace paths reuse the existing server fallback. Environment is
explicit, with a Chat session, Configuration category and Operations tab, or
saved schedule Job when relevant. Bootstrap validates the URL environment before
loading its data, then restores the addressed view. Route application uses the
existing shell, environment, conversation and schedule controllers and respects
their guards. Environment transitions suppress intermediate history entries;
rejected Back or Forward navigation restores the accepted history entry. The URL
never contains drafts, credentials, approval choices, or mutation payloads.

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

`tool-basket-activity-fields.js` presents declared basket actions, document names
and result counts. It displays at most five names, each capped at 120 Unicode
characters after removing control/format characters. Returned sources without a
displayed name and further omitted results remain separate counts. Basket activity
never falls back to source IDs, paths, queries, model intent, raw outputs or input/
output previews; this applies to tool disclosures and live/replayed timeline
summaries. Other tools retain their existing preview policy. Bounded Runtime
`information_basket` status messages keep their exact filename punctuation and
casing, and do not count as tool invocations or override the active-tool status.
`basket-activity-model.js` projects these recorded statuses into a separate Sources
section in a positively identified Supervisor card, using the same ordered events
for live and replay views. Passive matches remain distinct from explicit search/read
statuses. Counts and names use the existing bounded display labels; the UI never
parses outcomes or pairs starts with completions from text or adjacency. A Started
row records an observed start, not an inferred running execution. Basket events do
not change role ownership, tool counts, model context or Runtime behavior.

`tool-process-activity-fields.js` projects declared process display fields without
branching on tool identities. Opted-in commands retain up to 4,096 characters and
whitespace; shared `conversation-tool-evidence.js` renders them as inert
preformatted text in both activity and approval disclosures. Working
directory, target, exit code and recorded process evidence remain distinct from
model-authored intent. Result output stays a bounded excerpt, and completion or
exit zero does not establish an application window or independent outcome check.
Terminal failures preserve recorded result fields and clipping flags. Old events
without declared input/output evidence remain unavailable; the UI never guesses
commands from rationale or opaque parameter summaries.

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

Dashboard Job suggestions are inert data in `dashboard-job-templates.js`. They open the ordinary schedule form with editable defaults, a selected model, device time zone and a new dedicated conversation target. Only explicit Save creates state. `schedule-job-creation.ts` adapts this Web-only target into an owner-created conversation and the existing scheduler contract; it never invokes the model. Existing-conversation creation remains supported. `configuration-feature.js` owns the composition of Configuration and its memory controls. `app-bootstrap.js` owns startup ordering, environment restoration, initial loading and route-controller composition; an unaddressed start activates Home.

Read tracking belongs only to the native Web UI backend. `session-read-state/service.ts` reads canonical session snapshots and projects unread assistant replies; `store.ts` persists the UI cursors in an environment-specific sidecar under `runtimeDir/web-ui/read-state/`. Runtime session files, model context and Runtime contracts remain unchanged. A persisted initialization timestamp treats existing history as read and tracks later replies, including newly created Job conversations. Read acknowledgements resolve only the displayed persisted assistant message or its exact completed request ID. Cursors advance monotonically and survive server restarts; invalid boundaries never acknowledge unseen replies. Browser consumers retain newer read revisions when older responses arrive late.

The native conversation list uses the existing `SessionService` disk reader and canonical client-visible projections once per refresh. It avoids offset pagination over changing conversation order and avoids sending all request-event histories through the managed Runtime RPC. Only Web UI read-state sidecars are written by this projection. Clearing messages keeps a fresh read revision so subsequent unread replies can replace the previous read receipt.

Read-state persistence is an optional Web UI projection. `session-read-state/availability.ts` isolates sidecar failures from listing, loading, clearing and deleting conversations. A failure returns `readStateStatus: "unavailable"` and unknown counts, preserves the sidecar for diagnosis, and leaves read acknowledgements unsuccessful. The browser keeps the last known receipt, labels unavailable tracking explicitly and resumes normal counts after a healthy list refresh. Canonical session and attachment failures remain errors. Workspace visibility is committed before change callbacks attempt to acknowledge visible messages, including drawer closure and responsive layout changes.

## Conversation file preview

`conversation-file-reference.js` projects only explicit successful file-output
receipts from tool events. Activity keeps this reference separate from the
historical sent/received fields and excerpt. `conversation-file-action.js` makes
the existing filename an inline preview control inside the tool summary. Its click suppresses disclosure activation;
other summary interactions retain the recorded evidence disclosure.

`conversation-file-preview-controller.js` owns scoped loading and stale-response
rejection. The feature adapter mounts the viewer outside the message subtree and
preserves conversation scroll while the layout changes. Session resets and
workspace departure close it; responsive focus and Escape behavior belong to
`conversation-file-focus.js`. Transport stays in the conversation-files service.

The local backend's `conversation-file-access.ts` admits only a saved or scoped
active completion belonging to the requested environment, session and request.
`conversation-file-target.ts` owns the held file and root/containment identity
checks shared by content reads and native opening. The route revalidates request
generation and completion before returning bytes or handing off to a Mac app.
`conversation-file-native-request.ts` limits native opening to same-origin JSON
POSTs from a local browser on macOS. `conversation-file-native-open.ts` restricts
file types and invokes the fixed OS opener without a shell. The viewer exposes
this action only when its preview response includes `nativeOpenAvailable: true`;
its controller scopes busy/failure feedback to the selected file. The OS app
resolves the original pathname after handoff; that asynchronous read is outside
the preview reader's held-descriptor guarantee. The receipt
is presentation-only: the optional filesystem report callback feeds event
metadata, never the canonical tool result or model context. No file registry or
historical content snapshot is created.

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
refreshes from committed server changes while the workspace is active and visible.
The event refresh queue coalesces bursts and preserves changes received during
reads or mutations; reconnection and visibility return reconcile missed changes.
Background updates retain the open editor and the selected run-history page.
The full Schedules workspace shares the shell navigation and discard guards;
its editor uses an explicit save and a saved model/mode with selectable Full or
FULL+ tool access. Full remains the default; FULL+ must be selected explicitly.
The run history shows the permission captured for each invocation.
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

## Interactive setup and configuration activation

The setup guide composes focused rendering/validation modules and receives
configuration transport callbacks. Runtime onboarding retains catalog authority
over chat readiness. Home suppresses its dashboard data and shortcuts while
setup is required; the guide has one scroll owner in either Home or Chat.
OpenAI credentials live only in the current password input and one save payload.
They never enter browser state, HTML attributes, preferences or control logs.

The setup sequence is Provider, Connection, Embedding, Plugins and Ready.
The onboarding feature assembles transport dependencies outside app.js; focused
step modules own embedding and plugin card selection. Chat connection writes
defer activation in the wizard, while ordinary setup API callers retain their
existing immediate-activation behavior. The pending-activation gate keeps the
catalog unavailable until the explicit final apply, including browser reload in
the same Web process. Optional choices are read back from canonical saved files.

Embedding setup prepares only the requested provider and its private credential,
then delegates to the existing memory probe-before-save service. Probe dimensions
and fingerprints come from the provider response; the UI never invents them.
Provider preparation may survive a later probe failure, which is reported without
exposing credentials. The memory Web router resolves the current configuration
path per request so first-time setup uses local/runtime.config.json correctly.
Plugin cards reuse the existing manifest selection API, preserving sibling tools
and saved policies. Fresh installations start with all plugins and tools selected.
The onboarding plugin cards display every tool checkbox directly. Their dedicated
stylesheet widens only this step and keeps the outer workspace as the scroll owner.

Configuration composes a plugin manager using the canonical manifest selection
projection. The separate activation control explicitly applies saved files.
The server checks synchronous owner admission, refuses busy or externally owned
environments, and refreshes its gateway through the owning lifecycle callback.
Browser reload and saved selection are not evidence of live activation.

Plugin configuration uses the existing manifest defaults and secret declarations.
`components/plugins/configuration-fields.js` owns the shared install/edit form;
`configuration-editor.js` keeps an editing dialog outside dashboard replacement.
Installation drafts move their existing controls during rendering rather than
serializing password values. Environment/workspace navigation respects unfinished
configuration, and writes keep the existing external mutation guard.

`plugin-configuration-service.ts` owns saved-value validation and the redacted
projection. Its private store is installation-scoped, outside plugin packages,
and survives removal. Saves and Apply acquire the canonical Runtime-file lock
then the private-store lock. The plugin loader captures local values once per
compiled configuration lifetime, preserving previous-owner rollback without
changing plugin SDK or manifest contracts. No process environment is mutated.

### Additive model setup

Configuration composes a separate Provider / Model / Ready dialog in
components/model-setup/. It shares the wizard shell and connection form with
first setup, while retaining its own additive save/apply lifecycle. The dialog
is outside the dashboard so refresh and mutation locking cannot detach it.
An entered API key remains only in the mounted password field until final save;
review and back navigation do not copy it into state or markup.

configuration-feature.js guards opening against existing configuration drafts,
blocks workspace/environment navigation while the dialog is open, and holds the
external mutation lock during save, Apply and refresh. Saved model identity
survives Apply failure; successful Apply survives refresh failure. Completion
refreshes Memory provider choices and chat models, selects the new profile, and
focuses it only after closing the modal and releasing the lock.
Deferred activation refreshes the saved declaration without marking it active or
refreshing the active chat catalog. The dialog distinguishes saved/pending status
from save failures, and closing it does not undo the saved declaration.

local-runtime/model-setup-\* owns catalog/input/credential/addition behavior.
It uses the canonical configuration repository and shared CLI merge helper,
preserving existing profiles, references, defaults and connection settings.
Only new OpenAI/Ollama connections are created here; existing provider IDs are
resolved by adapter type. The transport exposes no secret values and requires
the same-origin JSON mutation guard. This flow does not invoke a model.

New Web additions use a model file and `configRef`; existing inline profiles
remain supported. Declaration removal uses the canonical Runtime lock and loaded
root revision, validates the remaining configuration for every environment, and
keeps referenced files, providers and credentials. Discovered files without a
declaration remain editable and are explicitly marked as not registered.

## Projects and permission modes

`projects-feature.js` composes project UI; `projects-controller.js` owns project
and folder loading, creation and stale-response rejection. Presentation modules
render the creation form and sidebar groups, while `runtime-web-client/projects.js`
owns transport. The folder form occupies the chat canvas without resetting the
active conversation or draft. It closes the file viewer through its existing
presentation lifecycle. Creation calls the owner API; a saved project session is
opened through the canonical conversation controller without a model request.

The session controller remains the owner of session row actions and read state.
Its injected group renderer places project groups above ordinary conversations,
including projects with no sessions. The session's saved project snapshot also
provides the visible working-folder label. Neither project presentation nor client
request payloads overwrite global runtime paths.

Sidebar requests opt into grouped metadata pages: all project headers are
available immediately, each project starts with five unpinned conversations,
and ordinary conversations have their own configured page size and total.
Pins do not consume either quota. `session-read-state/sidebar-pagination.ts`
owns group selection and query-bound cursors; `session-list-pagination.js`
keeps independent pending, error and continuation state per project. Expanding
one project never advances another group's cursor. A changed deletion catalog
restarts only the ordinary window so newly regrouped conversations remain
reachable. Selected summaries retain global order for automatic restoration.
Legacy list requests retain their existing response behavior.

Project grouping and sidebar reordering share the saved project ID and the
owner's deleted-project catalog. Deleting a project moves its conversations into
the ordinary list without modifying session snapshots, history or working folders.
The retained snapshot still provides the open conversation's working-folder label.
Deletion also applies to groups inferred from historical sessions; unrelated
inferred groups remain visible. Names, paths and session-ID shapes never select
special grouping rules. Global pins, search and bounded previews remain intact.

Collapsed project IDs live in the existing installation preferences, scoped by
environment, and survive refresh and reopening. Search expands matching groups
only for its duration and does not overwrite saved collapse choices. The header
search button reveals the input; closing it clears the temporary query.

`tool-permission-mode-controller.js` owns the permission selector and explicit
per-session preference changes; `lib/tool-permission-mode.js` owns known browser
values and server compatibility. FULL+ requires advertised server support, and
transport rejects unsupported requests without a silent downgrade. The existing
composer queue keeps its captured mode. Project membership never selects FULL+.
`app-state.js` constructs the same one shared browser state identity for `app.js`.

Home approvals reuse the local Web transport's live approval promises through
`GET /chat/approvals`. An explicit decision POST binds the environment, session,
request and approval identities and rechecks live ownership before resolving it.
The dashboard controller discards old-environment responses; discovery and
approval never load or mark a conversation as read. External bridge connections
show that Home discovery is unavailable. The shared approval card keeps recorded
execution evidence visible and places the complete rationale in a native disclosure.

Startup keeps the app inert and hidden from the initial HTML until workspace
restoration finishes. The branded startup screen reveals the app once ready;
failed bootstrap reads remain on an error with an explicit Reload action.

## Persistent SPARK popup

`spark-chat-feature.js` is composed by `app-bootstrap.js` outside the exclusive
workspace panels. It owns separate conversation state and DOM while reusing the
ordinary session, submit/queue, steering, approval, attachment, replay and rendering
controllers. Opening the popup does not replace the main selected session or draft.
The launcher defaults to the sidebar above the environment picker. Its drag position
is a browser preference shared across environments, with keyboard movement and a
settings action to return it to the sidebar. The popup anchors above or below the
launcher and stays inside the viewport.
The external launcher remains visible and toggles the popup even while it is open;
the header mascot also minimizes the chat. Free placement and anchor geometry stay intact.
Drag release gently aligns to a nearby 16px grid and settles into the saved position.
The popup fades and moves in from its launcher-facing edge without scaling message
geometry; placement motion respects reduced-motion preferences.
The marked permanent conversation is omitted from ordinary session listings.
Initiatives are presented only in the popup. Home and the SPARK page have no
proposal cards, card read filtering, dismissal actions or legacy suggestion toasts;
their status views show the actual collection, learning and proactive activity.
Popup notifications and read tracking belong to the companion alone. Desktop
notification records derive the SPARK kind from the canonical persisted session.
Their validated `/home` destination binds the environment, companion and exact
message/request reference; ordinary conversation and automation destinations keep
their existing contracts. The retired
manual proposal-dismissal HTTP/RPC path and browser preference facade are removed;
learning status no longer transports the card-only list of proposal contents.
Durable engine receipts, delivery events and deletion-derived settlement remain
owned by the proactive engine. Historical work sessions remain accessible through
the ordinary session list.

The native `/runtime/spark/chat` contract supplies the canonical session snapshot,
shared proactive model selection and persisted tool permission preference. Changes
live in SPARK's Chat tab; the shared model selector remains under Proactive mode
in Settings. Chat also hosts the existing Low / Reasoning / Deep selector, backed
by the companion view state and used by ordinary send/queue capture. The compact
composer keeps attachment, stop and send actions inside one input row; permissions
remain in Chat settings. The popup settings button opens Chat directly. Clear uses the
ordinary session-history cleanup route and
keeps the session identity and preferences. The owner rejects clearing while a
request or saved approval is active, reserves admission during cleanup, and removes
only captured transcript attachment references so a concurrent new upload survives.
Exact cleanup references are committed before history removal and retained on deletion
failure for an explicit retry, including after restart. Proactive delivery shares the
same admission boundary through message persistence, delivery receipt and notification.

`spark-chat-reading.js` captures the first unread anchor before acknowledging any
visible rows. SPARK read tracking uses exact persisted message identities rather
than the ordinary cumulative read cursor; offscreen messages remain unread. Each
receipt binds the observed message ID, timestamp and request identity plus the
read generation. Initiative request identity remains null even if a later ordinary
answer repeats its text. A delayed acknowledgement cannot mark a reused post-clear ID.
Unread availability failures preserve the last known state and draft.
The initial/reconnected snapshot produces one summary indication. Later new
persisted assistant messages produce one indication each while the popup is closed,
independent of streaming deltas and replay. An open popup suppresses the extra
floating preview. View state, reads and realtime events remain environment scoped.

`spark-chat-sync.js` reconciles durable snapshots and restores ordinary request
replay after reconnect. Environment navigation first prepares both ordinary and SPARK
queue recovery. Recovered drafts and their files are released only after every
navigation guard accepts; failed saves leave the current composer intact.
Shared rendering delegates popup scroll and asynchronous
layout changes to its reading controller, keeping the ordinary view unchanged.
The companion presents a friendly empty state and working indicator. Its canonical
SPARK policy keeps replies in the current user's language unless another is requested,
without announcing a language switch. It treats earlier assistant messages as its
own conversation and distinguishes an empty long-term recall from available history.
Its result view
retains canonical file actions, web sources, failures and partial-result warnings;
session event inspection, raw reasoning, context controls and routine completion
status stay out of the companion. Approval and execution mechanisms remain shared.

SPARK initiatives enter ordinary conversation history once as assistant messages in
canonical order. They form settled assistant-only units without inventing a user
request and follow the same checkpoint/compaction policy as other settled turns:
older units are summarized while the latest ten remain exact. The saved transcript
is retained for display and handoff. There is no separate initiative context block;
saved reasons, source metadata and handoff briefs are not projected into chat model
inputs. Request snapshots keep the existing exact source validation contract.

Persisted initiatives expose an explicit handoff action when canonical metadata
includes a saved title and brief. The client sends only the exact source message
reference to `/runtime/spark/chat/sessions`; it never invents or submits the brief.
`spark-handoff-navigation.js` captures the ordinary workspace and environment,
then opens the returned ordinary session through its existing session controller.
It submits no chat message or model request. Old suggestions without saved context
show a disabled action and explanation. Legacy Keep/Not interested and Not now
controls are removed; their stored historical preferences and statuses remain.

## Information basket workspace

`information-basket-feature.js` dynamically mounts Resources without expanding
`index.html`, then composes its controller, view and existing shell/realtime seams.
`information-basket-controller.js` owns the environment-bound management projection,
revision-bound mutations, explicit settings drafts and stale-response guards.
`information-basket-picker-controller.js` separately owns Runtime directory reads,
pagination and selected source paths. Browser drops retain filenames only; they
never read file bytes or synthesize absolute paths.

The focused components under `components/information-basket/` render the wide drop
area, responsive source table, source details and native picker dialog. They receive
actions and snapshots and never call HTTP. The transport module under
`services/runtime-web-client/information-basket.js` owns URLs and serialization.
The Runtime basket service remains canonical; the browser holds no vector index,
source content or persisted duplicate resource registry.

Home projects already-detected source problems through
`lib/information-basket-attention.js`; `dashboard-resources-controller.js` owns
its metadata reads and revision-bound quick actions. It joins the existing Home
refresh/event gates without polling or rescanning files. Environment/readiness
changes invalidate pending results; onboarding hides the card and picker.
The Resources panel joins the shared compact Home widget/dialog layout.

Reindex retains the source path. Relink reuses the Runtime file picker to select
one explicit replacement path for the same source ID and expected revision.
The management service queues the replacement; the UI does not report indexing
success until canonical source state does. This does not add model tools or
change retrieval, prompts or request execution.
