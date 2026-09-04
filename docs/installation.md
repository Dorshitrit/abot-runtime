# Installation

This guide covers three entry points:

- install `@abot-ai/runtime` as a local application with its Web UI
- install `@abot-ai/runtime` as a library in another TypeScript project
- clone this repository and run the local development services

## Prerequisites

- Node.js `^20.19.0` or `>=22.12.0` (Node.js 21 is not supported)
- npm
- TypeScript-capable host project if using the library directly
- Optional: an installed and running Ollama service for Ollama model profiles
- Optional: OpenAI API key for OpenAI model profiles

## Prepare Ollama (If Selected)

ABot Runtime ships an Ollama adapter, not the Ollama server or any model
weights. Install Ollama from the
[official download page](https://ollama.com/download), choose a concrete
`<model-id>` from the [Ollama model library](https://ollama.com/library), and
start the Ollama service using the instructions for your platform.

After the service is running, pull the chosen model and confirm the API lists
it:

```bash
ollama pull <model-id>
curl http://127.0.0.1:11434/api/tags
```

Use the same `<model-id>` in the runtime model profile. The URL above assumes
the command and Ollama share a host/network namespace. If the runtime reaches
Ollama at another origin, pass it during initialization:

```bash
npm run init -- --provider ollama --model <model-id> --base-url http://<ollama-host>:11434
```

The origin is written to `models.providers.ollama.baseUrl` in the generated
runtime config. Docker Desktop can usually reach Ollama on its Windows or macOS
host at `http://host.docker.internal:11434`; WSL, other container layouts, and
remote hosts may use a different address. The only requirement is that the
runtime process can reach it.

## Install The Local Application

Create a directory that will own the consumer's configuration and runtime
state, then install ABot Runtime into it:

```bash
mkdir my-abot
cd my-abot
npm init -y
npm install @abot-ai/runtime
```

Initialize a provider and concrete model id:

```bash
npx abot init --provider ollama --model <model-id>
```

If Ollama is outside the runtime process's network namespace, add
`--base-url http://<ollama-host>:11434`. For OpenAI, use:

```bash
npx abot init --provider openai --model <model-id>
```

Then place `OPENAI_API_KEY` in the generated `.env`. The generated OpenAI model
profile uses the recommended `execution-agent-v1` policy.

Start the model gateway and packaged Web UI together:

```bash
npx abot start
```

Open [http://127.0.0.1:5177](http://127.0.0.1:5177). The command binds to
loopback by default. If no usable model is configured, the Web UI still starts
and presents its setup guide.

Add another model without replacing existing providers or profiles:

```bash
npx abot add-model --profile <profile-id> --provider openai --model <model-id>
```

Add `--default` only to select that profile as the default. It does not delete
the profiles that are already configured.

### Optional Passive Long-Term Memory

Long-term memory is disabled by default. After a provider is configured, choose
an embedding model and enable it through the Web UI Config workspace or CLI:

```bash
npx abot memory status
npx abot memory models --provider <provider-id>
npx abot memory enable --provider <provider-id> --model <embedding-model-id>
```

ABot does not install or choose the embedding model. The enable command performs
a real probe, writes config only after it succeeds, and reports that the Runtime
must be restarted. OpenAI users enter the embedding model id manually; Ollama
users can discover model ids installed at the configured Ollama endpoint.

See [Passive Long-Term Memory](long-term-memory.md) before enabling persistence.

## Use As A Library

After the package is published:

```bash
npm install @abot-ai/runtime
```

Use only public exports from `package.json`:

```ts
import {
  createDefaultRuntimeDependencies,
  loadRuntimeConfig,
} from "@abot-ai/runtime/runtime";

const config = loadRuntimeConfig({ rootDir: process.cwd() });
const runtime = createDefaultRuntimeDependencies(config);
```

For a complete host example, see
[`examples/runtime-library-host.ts`](../examples/runtime-library-host.ts).

The consumer owns its runtime root and machine-local configuration. The CLI
above creates the documented layout; library hosts may instead start from the
packaged examples:

```text
local/runtime.config.json
local/request-runner.config.json
local/models/default.config.json
```

Set `LLM_RUNTIME_CONFIG_FILE=local/runtime.config.json` when the host process
does not pass `configPath` directly. Edit the copied provider and model profile
before starting the runtime; the package does not choose a model. For Ollama,
the provider `baseUrl` must be reachable from the consumer host and the model
profile must name the exact model id that consumer pulled.

The package includes the public plugin catalog. Additional consumer plugins may
be installed under `<consumer-root>/plugins`. A consumer plugin cannot replace
a bundled plugin: duplicate plugin ids fail closed.

The passive long-term memory service belongs to the Runtime core and does not
depend on the bundled `memory` plugin.

The bundled Web plugin supports URL fetching and Light search without a search
credential. Light searches a limited catalog of public Hebrew and English
sources directly; it does not query an external search engine or provide
whole-web coverage. Set `BRAVE_SEARCH_API_KEY` to use Brave Search instead.
A configured Brave key that fails remains a Brave error. See
[Known Limitations](known-limitations.md#web-search) for Light's discovery and
cache boundaries.

## Run From Source

```bash
git clone <repo-url>
cd abot
npm install
npm run init -- --provider ollama --model <model-id>
npm run build
npm test -- --run
```

The init command requires an explicit provider and concrete provider model id;
the runtime has no built-in model choice. For OpenAI, use
`npm run init -- --provider openai --model <model-id>`. The init step creates a
generic profile named `default` and is non-destructive by default; pass
`--force` only when you intentionally want to regenerate `.env`,
`local/runtime.config.json`, and the generated default model profile.
For Ollama outside the runtime process's loopback network, add
`--base-url http://<ollama-host>:11434`.

For Ollama, complete the service, pull, and API verification steps above before
starting the model gateway. Initialization only writes runtime configuration;
it does not provision the provider or model.

### Add Another Model

After initialization, add another provider or another profile without
replacing the existing configuration:

```bash
npm run add-model -- --profile <profile-id> --provider openai --model <model-id>
```

The profile id must be unique. If the provider already exists, its current
configuration is preserved. Add `--default` when the new profile should become
the request-runner default; all existing providers and profiles remain in
place. Set any required credential, such as `OPENAI_API_KEY`, in `.env`, then
restart the model gateway and Web UI. OpenAI profiles created by either setup
command include `execution.policy: "execution-agent-v1"`.

Provider connectivity is only the installation check. Before relying on a
model for real workloads, follow [Calibrating A Model By
Step](configuration.md#calibrating-a-model-by-step) to tune the exact model
profile without changing runtime policy or another model's settings.

The repository ignores `.env`, `local/runtime.config.json`, `.runtime/`, and
`dist/`. Do not commit local secrets or generated runtime state.

## Verify Package Surface

Before publishing or opening a release PR:

```bash
npm test -- --run
npm run build
npm run smoke:runtime-package
npm run check:runtime-package
npm run smoke:packed-runtime-package
git diff --check
```

`npm run build` regenerates `runtime.config.schema.json`, clears stale `dist`,
and compiles the published TypeScript declarations.

For the full public release checklist, see
[`docs/publishing.md`](publishing.md).
