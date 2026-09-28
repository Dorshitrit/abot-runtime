# Known Limitations

`abot` should be treated as a technical preview. The limitations below describe
its current public contracts and operational boundaries.

## Stability

The package exports map is the public API boundary. Files outside the exported
entrypoints may move without notice.

The current public entrypoints are:

- `@abot-ai/runtime`
- `@abot-ai/runtime/runtime`
- `@abot-ai/runtime/runtime/config`
- `@abot-ai/runtime/runtime/composition`
- `@abot-ai/runtime/runtime/default-adapters`
- `@abot-ai/runtime/runtime/adapters`
- `@abot-ai/runtime/runtime/ports`
- `@abot-ai/runtime/plugin-sdk`
- `@abot-ai/runtime/plugin-sdk/computer-access`
- `@abot-ai/runtime/model-gateway`
- `@abot-ai/runtime/runtime.config.schema.json`

## Bridge Requirement

The runtime can be embedded as a library. The package includes a local Web UI
transport for browser-based use, while external app-style flows can use a host
or bridge transport. The runtime should remain the source of truth for session
state and request events; a bridge should relay and recover from runtime-owned
state, not replace it.

The existing bridge protocol still contains legacy `agentId` field names. In
runtime documentation and config, treat this value as a runtime identity or
environment identity, not as multi-agent management.

## Model Gateway

The runtime calls models through the configured model gateway client. A usable
local setup still needs a model provider and gateway process, such as Ollama or
OpenAI through the model gateway.

Provider secrets belong in environment variables or a host secret store. They
must not be committed in runtime config.

## Model Invocation Timeouts

Model-step timeouts currently use a fixed wall-clock deadline. A local provider
can still be making healthy progress when a long content-generation step reaches
that deadline, while the runtime client has not yet received the gateway's final
response.

Configure `timeoutMs` for the latency of the concrete provider, model, and step.
Increasing it only extends the deadline; it does not improve model behavior.

## Plugins

The manifest plugin loader is synchronous and expects each package entrypoint
to be CommonJS, normally `plugins/<id>/src/index.cjs`. Native ESM and async
plugin entrypoints are not currently supported.

Plugin behavior belongs inside the plugin. Runtime orchestration should only
see the generic selected catalog and execution results.

## Web Search

With a configured `BRAVE_SEARCH_API_KEY`, `web_search` uses Brave Search and
preserves its authentication and rate-limit errors. Without a key, Light search
discovers and ranks pages within a catalog of public Hebrew and English
sources. It contacts content sources directly, without another search engine.

Light does not maintain a whole-web index. Its source selection, crawl depth,
candidate count, response sizes, and request deadline are bounded. Results may
be partial because a source is unavailable, disallows crawling, or exceeds a
budget. Zero matches mean no matches in the inspected sources, not that the
information is absent from the web. Source coverage accompanies the results.

The document cache exists only in the plugin instance's memory, bounded to
16 MiB of serialized content and 500 documents. Feed entries expire within
five minutes and page entries within 30 minutes; origin directives can shorten
these lifetimes. Restarting the runtime clears the cache. There is no background
crawl, browser rendering, or persistent search database. Content that requires
JavaScript may therefore be unavailable. Exact public URL fetching remains a
separate `web_fetch` capability with its existing public-network restrictions.

## Passive Long-Term Memory

Passive long-term memory is disabled by default and requires an embedding model
selected and operated by the consumer. ABot provides OpenAI and Ollama adapter
contracts, but it does not install, download, or choose that model.

Ollama exposes installed-model discovery. OpenAI does not expose equivalent
discovery through this integration, so its embedding model id is entered
manually. If an enabled embedding provider becomes unavailable, memory
retrieval or saving is skipped while the completed user response is preserved.

## Web UI

The packaged Web UI is the primary local GUI. Its default backend talks directly
to the local runtime process. `LLM_RUNTIME_WEB_BACKEND=bridge` enables an
external bridge proxy. Neither transport is the runtime state owner, and neither
should be used as the architectural boundary for sessions, events, or final
request state.

## Steering And Cancellation

Text steering is not a hard cancellation mechanism for active delegated work.
The Web UI Stop control and local Runtime cancellation API explicitly cancel an
active request and preserve its stopped conversation context. Stopping does not
undo completed tool effects. Cancellation must not be inferred from message wording.

## Saved Tool Approvals

Web UI requests save a pure approval wait with the conversation and release their
live execution resources. Compatible waits survive Runtime restart and resume the
prepared action only after an explicit decision. New requests and Jobs in that
conversation are blocked while it waits; cancellation remains available.

Restart interrupts work that was actually running and never replays it
automatically. An incompatible or unreadable continuation stays pending and
cancellable. Older approval events cannot be upgraded into executable
continuations. Bridge and scheduler clients without durable-approval support
retain their existing live-owner contract.

## Generated State

Generated runtime state remains local and ignored:

- `.runtime/`
- `dist/`
- `logs/`
- `sessions/`

Do not publish local runtime state, logs, memory, generated work output, or
machine-specific config.

## Conversation file viewing

File previews require the local Runtime backend and a filesystem that supplies
stable directory identity. Missing identity omits only the preview action;
committed writes and edits retain their normal results. Windows-mounted folders
in WSL can lack the required directory birth identity. This feature does not
translate Windows/WSL paths or depend on an editor integration.

Opening a file in its default desktop app is available only on macOS from a
local Web UI connection, for supported non-executable documents and images.
The server checks the recorded file authority before the handoff. The external
app resolves the pathname asynchronously; it does not inherit the preview
reader's pinned file descriptor. Native opening is never automatic.
