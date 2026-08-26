# abot Web UI

This is a local web client hosted from `abot`.

It is intentionally a client/transport layer only:

- By default, the UI talks directly to the local `abot` process.
- `LLM_RUNTIME_WEB_BACKEND=bridge` enables an external bridge proxy path.
- The web transport does not own sessions, request state, planner state, or
  replay state.
- Runtime core orchestration is not changed for the web UI.
- Existing external bridge clients remain unchanged.

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
