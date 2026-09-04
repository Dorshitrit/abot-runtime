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

`workspace-shell.js` is the single owner of workspace navigation. It owns the active Chat or Config workspace, responsive Conversations visibility, focus restoration, Escape handling, backdrop state, and related ARIA attributes. `conversation-sidebar-layout.js` resolves the sidebar presentation policy; `operations-section.js` owns the internal Runtime, Logs, and Health tabs within Configuration. These components must not own session data, request state, or Runtime transport.

`conversation-activity.js` owns only request-scoped activity presentation. `realtime-event-controller.js` preserves sequence authority, associates events and progress with their exact `requestId`, and injects those values into the conversation view. `realtime-transport.js` only parses and transports frames; it does not reduce application state.

`composer-context-window.js` presents the existing context estimate as one compact composer indicator. It selects the active assistant request, or the newest conversation message only when it is a request-linked assistant message while idle. A pending user turn, an assistant message without a request ID, or missing metrics hides the indicator instead of falling back to an earlier request. Context metric updates refresh it independently of message tokens; session-view resets clear it. Estimated usage, provider-reported usage, and compaction remain distinct, and provider usage stays bound to the matching model invocation.

`composer-plan.js` presents the current user turn's Planner plan in a collapsed-by-default drawer above the composer. `composer-plan-model.js` selects request-linked progress from the current turn, including restored failed requests that have only a persisted user message; a new user turn hides earlier plans. Disclosure identity follows the selected request, so steering preserves expansion and list scroll; session resets clear the drawer. `task-progress.js` reduces structured plan events by request: full snapshots replace the baseline, later item changes are retained across overlapping replay, and completion counters never imply request or Reviewer success. Live events and stored replay use this same projection. Historical per-response progress remains available in Activity.

Activity counts tool invocations from `tool.started` entries and their recorded multiplicities before timeline display grouping. Completion, payload, and approval events remain visible but do not add tool invocations; terminal-only history does not invent missing starts. Failure-event counts retain their existing meaning.

Web sources appear in a separate Activity section alongside role cards and the event timeline. `web-source-event.js` projects only successful `web_search` and `web_fetch` completions; `web-sources.js` validates bounded plugin receipts and groups them by recorded call. `conversation-sources.js` renders links and retrieval/presentation states without interpreting answer text. Source-bearing events retain their own identity before display grouping, and stored session events use the same projection as live events. Session switching clears them with the existing Activity state.

The optional `meta.webSources` version 1 receipt describes the final bounded **tool output**, not whether a later model invocation consumed or cited it. Older events can show found/fetched URLs with unknown output visibility; absent or unsupported receipts never imply full content. Favicons are best-effort browser requests to the source origin's `/favicon.ico`, loaded lazily with no referrer and a local fallback. No third-party icon service or server proxy is used. Source URL policy rejects unsafe schemes and credentials, and prevents automatic image loads for local/private IP literals; origin DNS, redirects, cookies, and browser image policy remain browser concerns. Icons carry no evidence and never block tool execution.

`conversation-session-controller.js` is the single owner of the active conversation view lifecycle: normalized message identity, session switching, stored-message hydration, request-event replay, read state, active assistant placeholders, and session/request realtime subscriptions. `chat-request-controller.js` owns starting one chat request, while `composer-submit-controller.js` owns the composer's selected action and busy/error lifecycle. `tool-approval-controller.js` owns approval state and transport; `tool-approval-card.js` owns its DOM presentation.

The primary information architecture is chat-first:

- the navigation rail is persistent;
- Chat and Config are mutually exclusive workspaces;
- Conversations is docked beside Chat from 1260 CSS pixels upward, with its own column and no modal backdrop;
- below that width, Conversations is the only transient sheet and overlays the chat canvas;
- Configuration always hides Conversations and uses the full content canvas;
- request tools, progress, and failures remain attached to the corresponding assistant response;
- Configuration contains one Operations section with the existing Runtime, Logs, and Health views;
- the Operations section is a static sibling of the generated configuration dashboard, so dashboard rerenders cannot detach its controls or status nodes;
- internal Operations tab changes preserve configuration drafts; leaving Configuration remains guarded by the explicit discard check.

Panel resizing and persisted panel widths are intentionally not part of this architecture. Crossing the sidebar breakpoint closes transient drawer state and restores focus when its previous target becomes hidden.

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
