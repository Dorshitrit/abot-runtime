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

`workspace-shell.js` is the single owner of workspace navigation. It owns the active Chat, Operations, or Config workspace, Conversations sheet visibility, Operations tab navigation, focus restoration, Escape handling, backdrop state, and related ARIA attributes. It must not own session data, request state, or Runtime transport.

`conversation-activity.js` owns only request-scoped activity presentation. `realtime-event-controller.js` preserves sequence authority, associates events and progress with their exact `requestId`, and injects those values into the conversation view. `realtime-transport.js` only parses and transports frames; it does not reduce application state.

`conversation-session-controller.js` is the single owner of the active conversation view lifecycle: normalized message identity, session switching, stored-message hydration, request-event replay, read state, active assistant placeholders, and session/request realtime subscriptions. `chat-request-controller.js` owns starting one chat request, while `composer-submit-controller.js` owns the composer's selected action and busy/error lifecycle. `tool-approval-controller.js` owns approval state and transport; `tool-approval-card.js` owns its DOM presentation.

The primary information architecture is chat-first:

- the navigation rail is persistent;
- Chat, Operations, and Config are mutually exclusive workspaces;
- Conversations is the only transient sheet and never reduces the chat canvas;
- request tools, progress, and failures remain attached to the corresponding assistant response;
- Operations owns Runtime, Logs, and Health as full-canvas views;
- Config remains a separate full-canvas destination.

Panel resizing and persisted panel widths are intentionally not part of this architecture. Only conversation discovery is an overlay; operational surfaces receive enough space to remain readable.

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
