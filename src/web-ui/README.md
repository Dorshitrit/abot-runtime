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
navigation. Refresh and five-second polling keep the current page; selecting a
different Job or environment starts at the newest page. The HTTP endpoint
defaults to 50 runs and accepts a maximum page size of 100, with a Job-scoped
cursor for older records. The owner query is bounded before local RPC transfer;
each returned record retains its complete prompt, result and execution details.

The local backend starts configured environments independently, so a slow or
unavailable owner cannot delay another environment's schedules. Shutdown awaits
the startup aggregate before stopping every created environment.

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
