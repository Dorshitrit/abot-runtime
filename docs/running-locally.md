# Running Locally

`abot` is a runtime library plus local service entrypoints. A complete
source-checkout setup usually has:

- a model provider, such as Ollama or OpenAI
- the model gateway process
- the runtime bridge client process
- optionally the local web UI proxy

When `@abot-ai/runtime` is installed from npm, the packaged CLI starts the model
gateway and Web UI together:

```bash
npx abot start
```

The remaining commands in this guide are the equivalent source-checkout
workflow for contributors.

## 1. Prepare Config

```bash
npm install
npm run init -- --provider ollama --model <model-id>
```

The init command requires an explicit provider and concrete provider model id.
It creates `.env`, `local/runtime.config.json`,
`local/models/default.config.json`, and the local runtime directories. Make
sure `.env` contains:

```bash
LLM_RUNTIME_CONFIG_FILE=local/runtime.config.json
```

## 2. Choose A Model Provider

### Ollama

ABot Runtime includes the Ollama adapter, but it does not install Ollama or
download a model. Install Ollama from the
[official download page](https://ollama.com/download), choose a concrete
`<model-id>` from the [Ollama model library](https://ollama.com/library), and
start the Ollama service using the instructions for your platform.

Once the service is running, pull the chosen model and verify that the Ollama
API lists it:

```bash
ollama pull <model-id>
curl http://127.0.0.1:11434/api/tags
```

Use that same `<model-id>` in `local/models/default.config.json`. The generated
provider config expects Ollama at:

```text
http://127.0.0.1:11434
```

`127.0.0.1` means the loopback network of the runtime process. It works only
when Ollama is reachable in that same host/network namespace. In particular:

- a runtime in WSL may need the Windows host address when Ollama runs on Windows
- a runtime in a container needs an address for Ollama outside that container
- a remote Ollama service needs its reachable host name or IP address

In those layouts, pass the URL that the runtime can reach during
initialization:

```bash
npm run init -- --provider ollama --model <model-id> --base-url http://<ollama-host>:11434
```

Docker Desktop can usually reach Ollama on its Windows or macOS host at
`http://host.docker.internal:11434`. WSL, other container layouts, and remote
hosts may use a different address. Run the `/api/tags` check against the chosen
URL from the runtime environment. You can also edit
`models.providers.ollama.baseUrl` in `local/runtime.config.json` later.

### OpenAI

Set the API key in `.env`:

```bash
OPENAI_API_KEY=...
```

Then configure an OpenAI provider/profile in `local/runtime.config.json`.
For a new checkout,
`npm run init -- --provider openai --model <model-id>` creates that
provider/profile for you and selects the recommended
`execution-agent-v1` policy in its model config.

To add OpenAI to a runtime that already has another model, keep the existing
configuration and create a distinct profile:

```bash
npm run add-model -- --profile <profile-id> --provider openai --model <model-id>
```

Use `--default` only when the new profile should become the default selection.
It does not delete or replace any existing provider or profile. Restart the
model gateway and Web UI after adding the model.

## 3. Optional Workspace Providers

`workspaceDir` is an optional host/library source path. The current
Supervisor-led `RuntimeHost.start(...)` path does not inject a
`WorkspaceProvider` or `ConversationContextProvider`.

Hosts that consume those public ports directly may use
`createSourceWorkspaceProvider(...)`, `createCompiledWorkspaceProvider(...)`,
or the related multi-workspace factory. Capability skills are loaded only from
the selected packages under `plugins/`.

## 4. Start The Model Gateway

```bash
npm run model-gateway
```

By default it listens on:

```text
http://127.0.0.1:3000
```

Logs go under the resolved `sharedDir` at `logs/model-gateway.jsonl`, unless
`MODEL_GATEWAY_TRACE_FILE` is set.

## 5. Start The Runtime Bridge Client

In another terminal:

```bash
npm run dev
```

This starts the runtime host from `index.ts` and connects to
`agentBridgeUrl` from the active config.

If you do not have a bridge server running, the process can start but cannot
serve app requests. In that case, use the library APIs directly or run your
own bridge host. See [bridge-compatibility.md](bridge-compatibility.md) for the
runtime/bridge ownership split.

## 6. Optional Web UI

```bash
npm run web-ui
```

The source-checkout web UI defaults to a direct local runtime backend. It
serves the browser UI, accepts `/web-api` chat requests, and streams runtime
events over `/web-realtime` without requiring an external bridge.

The environment picker is loaded from `environment.profiles` in the active
runtime config. Its initial selection is `environment.default`, or
`LLM_RUNTIME_WEB_ENVIRONMENT` when you explicitly set a web UI default.

Use bridge mode only when you intentionally want the web UI to talk through an
external bridge:

```bash
LLM_RUNTIME_WEB_BACKEND=bridge npm run web-ui
```

The web UI transport is optional local tooling. It relays to runtime or bridge
endpoints; it is not the source of truth for sessions, events, or final request
state.

## Runtime Output

Generated state is ignored by git:

- `.runtime/`
- `dist/`
- `logs/`
- `sessions/`

Delete generated state only when you intentionally want to reset local runtime
history, logs, memory, configured work artifacts, or compiled context.
