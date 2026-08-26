# ABot Runtime

Open TypeScript runtime for building inspectable AI agents with local or hosted
language models.

ABot Runtime provides the execution layer around a model: sessions, tools,
plugins, model routing, persisted events, and a local graphical interface. It
does not choose a model for you or hide model-provider behavior behind
hardcoded defaults.

## Features

- Configurable local and hosted model providers
- Persistent conversations, request events, and replay
- Planning, execution, and review workflows
- Manifest-based tools and plugins with explicit runtime boundaries
- Workspace, file, skill, and memory capabilities
- Streaming model and tool activity
- A local Web UI for everyday use and inspection
- An optional bridge transport for integration with external applications

## Web UI

The source checkout includes the project's primary GUI. It uses the direct
local runtime backend by default, so an external bridge is not required.

The Web UI supports:

- creating, reopening, and deleting conversations
- choosing the active environment, model, and reasoning mode
- uploading files and images
- streaming messages, current activity, tool progress, and failures
- steering an active request or queuing the next message
- editing runtime configuration
- inspecting runtime status, logs, and health

The UI is a client of the runtime; persisted sessions, events, and request state
remain owned by the runtime.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0` (Node.js 21 is not supported)
- npm
- A configured model provider and model

Ollama and OpenAI adapters are included. The Ollama server and model files are
not: install Ollama from the [official download page](https://ollama.com/download)
and pull a model you choose. OpenAI profiles require `OPENAI_API_KEY`. ABot
Runtime has no built-in default model.

## Install And Run

Create a consumer project and install the package:

```bash
mkdir my-abot
cd my-abot
npm init -y
npm install @abot-ai/runtime
```

Initialize one explicit provider and model, then start the model gateway and
Web UI with one command:

```bash
npx abot init --provider ollama --model <model-id>
npx abot start
```

Open [http://127.0.0.1:5177](http://127.0.0.1:5177). The generated files and
runtime state belong to the consumer project; installing the package does not
write into the package directory.

For OpenAI, set `OPENAI_API_KEY` in the generated `.env` and initialize with:

```bash
npx abot init --provider openai --model <model-id>
```

OpenAI profiles created by `abot init` or `abot add-model` use the recommended
`execution-agent-v1` execution policy. Existing profiles are preserved unless
the user explicitly requests replacement.

## Quick Start From Source

From a checkout of this repository:

If you are using Ollama, install it and make sure its service is running first.
On the machine that runs Ollama, choose a concrete id from the
[Ollama model library](https://ollama.com/library), then pull and verify that
exact model:

```bash
ollama pull <model-id>
curl http://127.0.0.1:11434/api/tags
```

Then initialize the runtime with the same model id:

```bash
npm install
npm run init -- --provider ollama --model <model-id>
```

The command above uses `http://127.0.0.1:11434`. When Ollama is reachable from
the runtime at another address, provide that origin explicitly:

```bash
npm run init -- --provider ollama --model <model-id> --base-url http://<ollama-host>:11434
```

The init command creates machine-local configuration, including `.env` and
`local/runtime.config.json`. It also sets `LLM_RUNTIME_CONFIG_FILE` in `.env`
so the local commands use that config. Both the provider and model are explicit.

The initializer configures the adapter; it does not install or start Ollama or
download a model. The configured URL must be reachable from the runtime
process. For example, Docker Desktop can usually reach Ollama on its Windows or
macOS host at `http://host.docker.internal:11434`; other WSL, container, and
remote layouts may require a different address.

Start the model gateway:

```bash
npm run model-gateway
```

Then start the Web UI in another terminal:

```bash
npm run web-ui
```

Open [http://127.0.0.1:5177](http://127.0.0.1:5177).

For an OpenAI profile, initialize with:

```bash
npm run init -- --provider openai --model <model-id>
```

The generated OpenAI model profile opts into `execution-agent-v1`.

To add another model to an initialized runtime without replacing existing
providers or profiles, give the new profile a unique id:

```bash
npm run add-model -- --profile <profile-id> --provider openai --model <model-id>
```

Add `--default` to select the new profile as the request-runner default. This
changes only the default selection; it does not remove existing models.

See [Installation](docs/installation.md) and
[Running Locally](docs/running-locally.md) for complete setup options.

## Use as a Library

Install the same package in a TypeScript host:

```bash
npm install @abot-ai/runtime
```

Compose the runtime from its public API:

```ts
import {
  createDefaultRuntimeDependencies,
  loadRuntimeConfig,
} from "@abot-ai/runtime/runtime";

const config = loadRuntimeConfig({ rootDir: process.cwd() });
const dependencies = createDefaultRuntimeDependencies(config);
```

The host owns startup, shutdown, transport, and process lifecycle. See
[examples/runtime-library-host.ts](examples/runtime-library-host.ts) for a
complete host and [Runtime Library](docs/runtime-library.md) for the supported
API surface.

## Configuration and Providers

The default config path is `runtime.config.json`. A host can instead pass
`configPath` or set `LLM_RUNTIME_CONFIG_FILE`; the source initializer uses this
mechanism to select `local/runtime.config.json`.

Provider profiles, model profiles, request-runner policy, environments, paths,
and optional bridge settings are configuration-driven. Secrets belong in
environment variables or a host secret store, never in committed config.

See [Configuration](docs/configuration.md) and the packaged
[`runtime.config.schema.json`](runtime.config.schema.json). Model behavior can
also be tuned per semantic step without adding provider-specific logic to the
runtime; see [Calibrating A Model By
Step](docs/configuration.md#calibrating-a-model-by-step).

## Plugins and Web Access

The distribution includes a curated public plugin catalog for development and
agent workflows: filesystem operations, command execution, document reading,
local search, memory, project inspection, JSON inspection, system probing, and
Web access. Hosts can add plugins under their own runtime root; duplicate plugin
IDs fail closed.

The Web plugin exposes two distinct capabilities:

- `web_fetch` retrieves a specific public HTTP(S) page without a search API key.
- `web_search` uses the Brave Search API and requires
  `BRAVE_SEARCH_API_KEY`. Without it, the capability returns a clear local
  configuration error before making a search request.

Some plugins have platform-specific requirements. See [Plugins](docs/plugins.md)
for their contracts, limits, and configuration.

## Architecture at a Glance

- The runtime owns request execution, sessions, events, context, and capability
  orchestration.
- The model gateway normalizes provider adapters, model profiles, and streaming
  responses behind one runtime-facing contract.
- Plugins own tool implementations and declare their capabilities, operations,
  parameters, skills, and required secrets.
- The Web UI and bridge are clients of the same runtime contracts.

For a deeper view, see [Architecture](docs/architecture.md).

## Documentation

- [Installation](docs/installation.md)
- [Running Locally](docs/running-locally.md)
- [Configuration](docs/configuration.md)
- [Runtime Library](docs/runtime-library.md)
- [Plugins](docs/plugins.md)
- [Troubleshooting](docs/troubleshooting.md)

## Project Status

ABot Runtime is an early-stage project. Only documented package exports are
part of its supported API; internal source paths may change between releases.

## Contributing, Security, and License

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities. ABot Runtime is
available under the [MIT License](LICENSE).

## Acknowledgements

**Product direction and architecture by humans. Code, tests, and documentation
by OpenAI Codex.**
