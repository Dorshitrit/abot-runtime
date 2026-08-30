# Runtime Library Usage

`abot` exposes the runtime composition surface as a library. Consumers
should import public runtime entrypoints only, not internal request execution,
loop, profile, model, context, or tool modules.

For the external plugin contract, see [plugins.md](plugins.md).
For the stable runtime ports and event/session/tool semantics, see
[runtime-public-contracts.md](runtime-public-contracts.md).
For prompt/policy contract ownership, see
[runtime-prompt-policy-contracts.md](runtime-prompt-policy-contracts.md).
For invariant coverage, see
[runtime-invariant-coverage.md](runtime-invariant-coverage.md).
For bridge/runtime ownership, see [bridge-compatibility.md](bridge-compatibility.md).
For current limitations, see [known-limitations.md](known-limitations.md).
For package and publication gates, see [publishing.md](publishing.md).

## Basic Composition

For a minimal composition example, see
[`examples/minimal-runtime-composition.ts`](../examples/minimal-runtime-composition.ts).

```ts
import {
  createDefaultRuntimeDependencies,
  loadRuntimeConfig,
} from "@abot-ai/runtime/runtime";

const config = loadRuntimeConfig({ rootDir: process.cwd() });
const runtime = createDefaultRuntimeDependencies(config);

const handle = runtime.host.start({
  runtimeConfig: config,
  runtimeId: config.runtimeId,
  agentBridgeUrl: config.agentBridgeUrl,
  agentBridgeToken: config.agentBridgeToken,
  eventSinkFactory: runtime.events,
  modelGatewayClient: runtime.models,
  sessionStore: runtime.sessions,
  attachmentStore: runtime.attachments,
  toolRegistry: runtime.tools,
});

process.on("SIGINT", async () => {
  await handle.stop();
  process.exit(0);
});
```

## Runtime Config

The default host reads `runtime.config.json`, then lets environment variables
override supported values. The public schema is available as
`@abot-ai/runtime/runtime.config.schema.json`. The package ships
`examples/runtime.config.example.json` as a sanitized starting point; it does
not ship the repository-local `runtime.config.json`.

```json
{
  "environment": {
    "default": "prod",
    "paths": {
      "sharedDir": ".runtime/shared",
      "compiledDir": ".runtime/compiled",
      "workspaceDir": "workspace"
    },
    "profiles": {
      "prod": {
        "paths": {
          "runtimeDir": ".runtime/prod",
          "agentWorkDir": ".runtime/prod/agent-work",
          "sessionsDir": ".runtime/prod/sessions",
          "attachmentsDir": ".runtime/prod/attachments"
        }
      },
      "dev": {
        "paths": {
          "runtimeDir": ".runtime/dev",
          "agentWorkDir": ".runtime/dev/agent-work",
          "sessionsDir": ".runtime/dev/sessions",
          "attachmentsDir": ".runtime/dev/attachments"
        }
      }
    }
  },
  "logging": {
    "enabled": true,
    "rotation": {
      "maxFileSizeMb": 20,
      "maxFiles": 10,
      "maxAgeDays": 7
    }
  },
  "plugins": {
    "enabled": true,
    "allow": ["*"],
    "deny": []
  },
  "models": {
    "providers": {
      "ollama": {
        "type": "ollama",
        "baseUrl": "http://127.0.0.1:11434",
        "keepAlive": "3m"
      }
    },
    "profiles": {
      "default": {
        "configRef": "./models/default.config.json"
      }
    }
  },
  "requestRunner": {
    "configRef": "./request-runner.config.json"
  }
}
```

`environment.paths.runtimeDir` is the generated/live runtime state root for one
runtime environment. By default, sessions, plugin-owned state, and runtime
logs live under that environment's `.runtime` subtree.
`environment.paths.sharedDir` is generated/live state shared by multiple runtime
environments, such as model-gateway logs. `environment.paths.compiledDir` is for
optional generated context artifacts. `environment.paths.workspaceDir` is an
optional workspace context source. `environment.paths.agentWorkDir` is the
configured primary root for plugin-created and modified artifacts; `.` and
relative paths resolve beneath it. `logging` controls the active JSONL trace at
the resolved `traceFile`: `enabled` toggles writes,
`rotation.maxFileSizeMb` rotates the active file by size, `rotation.maxFiles`
limits retained rotated siblings, and `rotation.maxAgeDays` prunes rotated
siblings by age. `runtime.logs.tail` continues to read only the active file.

Every installed capability and its skill bindings are declared by one package
under `plugins/`. The request-scoped Worker capability provider projects the
selected manifest operations and guidance from that catalog. Its name is
retained for compatibility; the same provider, binding, and payload author also
serve a policy-authorized canonical root. Directly passing a custom
`eventSinkFactory`, `modelGatewayClient`, `sessionStore`, `attachmentStore`, or
`toolRegistry` into `RuntimeHost.start(...)` remains an adapter escape hatch,
but bypasses the corresponding default config-driven composition.
`plugins.enabled`, `plugins.allow`, and `plugins.deny` are the only root
availability controls. Selectors may name `*`, a plugin, a capability, or
`plugin.capability`; deny entries win. Concrete contracts, implementation
defaults, secret declarations, and operation-level skill bindings live in the
matching `plugins/<id>/plugin.json` package.
When the active registry has no tools, no policy principal sees capability
affordances. The selected root may still answer directly, and delegated roles
may still return substantive results from supplied context or stable knowledge.
The runtime never fabricates a role decision or final assistant response.

`models.providers` declares provider adapter ids such as `ollama` and `openai`;
model profiles reference configured providers by id. API keys stay out of JSON:
OpenAI profiles use `apiKeyEnv`, usually `OPENAI_API_KEY`. `apiKeyEnv` is the
environment variable name, never the key value itself. `models.profiles.*`
can define provider model names, generation settings (`temperature`, `topP`,
`reasoningEffort`), the required physical context capacity
(`contextWindowTokens`), and context-projection settings
(`formatTokenAccounting` and `tokenEstimation`). Omission uses safe `estimate`
mode with zero fixed overhead; `none` disables format-token charges. Tool
observation and artifact projection are owned by their runtime context
contracts rather than model-profile calibration.
The runtime uses context budgets when assembling request history, and the
model-gateway maps provider generation settings to the provider payload.
Current-session history is retained in the canonical transcript and projected
to root decision/response steps as one passive semantic checkpoint plus recent
complete turns. The runtime invokes the shared `context.compact` model step at
the physical context threshold, persists the checkpoint with compare-and-swap,
and keeps the latest ten complete turns raw. There is no profile-level message
cap and no plugin or model-selected history checkout.

### Passive Long-Term Memory

Long-term memory is a separate core service for relevant cross-session facts;
it is not the current-session history checkpoint and does not depend on a
plugin. It is disabled by default and receives a dedicated embedding profile.

`createRuntimeApplication(config)` exposes management through
`runtime.services.longTermMemory`; `createDefaultRuntimeDependencies(config)`
exposes the same service as `runtime.longTermMemory`. Hosts may call
`status()`, `list()`, `delete({ id })`, and `clear()` without accessing vector
data.
The normal request path alone owns passive retrieval and candidate persistence.

See [Passive Long-Term Memory](long-term-memory.md) for setup and contracts.
For Ollama, `models.providers.<id>.keepAlive` owns model residency and a model
profile may use `options.num_ctx` for a lower stable provider allocation. The
gateway admits against the lower of that allocation and the declared
`contextWindowTokens`, then projects the effective value as Ollama `num_ctx`.
Calibration may tune context projection, but cannot change physical capacity
or provider allocation.
Additional provider protocols implement the public
`@abot-ai/runtime/model-gateway` adapter contract and are injected into the
gateway host. Adapter-owned, JSON-safe configuration belongs under the
provider's `settings` object. The runtime and gateway core do not branch on a
custom provider name, and an unregistered adapter id fails explicitly.
Configured profiles are composed only from host configuration and any referenced
profile file. The runtime does not inject model sampling settings; every such
value comes from configuration.
The main runtime `models` object is the installed-model catalog: providers and
profiles. Large profile definitions can live in separate files through
`models.profiles.<id>.configRef`, resolved relative to the runtime config file.
This keeps provider/model catalog data separate from request execution policy.
Each model profile may also select one registered model-facing execution
contract:

```json
{
  "execution": {
    "policy": "execution-agent-v1"
  }
}
```

The field is optional. Omission resolves to the behavior-compatible
`supervisor-worker-v1`; a configured profile may explicitly opt into
`execution-agent-v1`. Selection is frozen once per request and changes only
model-facing contracts and mechanical authority over the one shared kernel. It
is not an ordered steps array, model-strength heuristic, second runner, or
mid-request fallback. The loader keeps this orchestration metadata out of
provider-profile and model-gateway payloads.

Model profiles can expose independent calibration slots for
`supervisor.decision`, `supervisor.response`, `planner.decision`,
`planner.graph`, `worker.decision`, `worker.result`, `reviewer.decision`,
`capability.controls`, `execution.decision`, `execution.response`, `auditor.decision`,
`degraded.finalization`, and utility tool steps. `planner.decision` is the
delegated Planner contract; `planner.graph` is the distinct passive advisory
contract for `execution-agent-v1`. A raw step such as `worker.result` may also
reuse an existing raw-response calibration slot. The request-runner
`models.defaults.steps` map selects those semantic slot ids. The selected model
remains the base, and the slot applies that model's generation, context, and
optional format overlay.
`reasoningEffort` accepts `none`, `minimal`, `low`, `medium`, `high`, and
`xhigh`; the OpenAI adapter omits `temperature` and `topP` whenever a reasoning
profile is invoked with active reasoning.
Client `modelPreference` remains request-wide unless model policy explicitly
overrides it. Runtime model selection resolves through the shared model policy;
request-runner step mappings provide the configured model-step selection.
The gateway logs the resolved profile/provider/model as
`model.invocation.resolved`; use that event rather than the model's own answer
when checking which model handled a request.

`requestRunner.configRef` is required and resolves relative to the runtime
config file. The referenced `request-runner.config.json` owns the request
context budget plus every invoked model-step mapping and timeout. It does not
select an execution policy, entry contract, role hierarchy, or fixed sequence.
The selected model profile supplies `execution.policy`; the runtime then creates
one canonical root and RoleCall ledger regardless of which root contract is
active.

Within the request-runner context budget, `outputReserveTokens` is input
headroom: the runtime subtracts it before admitting prompt messages. It is not
forwarded as a provider output-token cap. The selected profile's
`contextWindowTokens` remains the physical capacity for every calibrated step.

Root request, inactivity, model-step, and stream timeout defaults remain
available under `timeouts`. Per-step `timeoutMs` values in the request-runner
config bound the corresponding configured request-runner model calls.

## Public Entry Points

- `@abot-ai/runtime`
- `@abot-ai/runtime/runtime`
- `@abot-ai/runtime/runtime/config`
- `@abot-ai/runtime/runtime/composition`
- `@abot-ai/runtime/runtime/default-adapters`
- `@abot-ai/runtime/runtime/adapters`
- `@abot-ai/runtime/runtime/ports`
- `@abot-ai/runtime/plugin-sdk`
- `@abot-ai/runtime/model-gateway`
- `@abot-ai/runtime/runtime.config.schema.json`

## Adapter Boundary

Use `@abot-ai/runtime/runtime/adapters` when you want the built-in file-backed
implementations:

```ts
import {
  createCompiledWorkspaceProvider,
  createFileSessionStore,
  createInMemorySessionStore,
  createMultiWorkspaceProvider,
  createSourceWorkspaceProvider,
} from "@abot-ai/runtime/runtime/adapters";
```

Use `@abot-ai/runtime/runtime/ports` for TypeScript types when providing custom
implementations from another host.

`createDefaultRuntimeDependencies(config)` exposes attachment persistence as
`runtime.attachments`; pass it to `RuntimeHost.start(...)` as
`attachmentStore`. Hosts that need a custom file-backed attachment store can
use `createFileAttachmentStore(...)` from `@abot-ai/runtime/runtime`, while
`createDefaultAttachmentStore(config)` is available from
`@abot-ai/runtime/runtime/default-adapters`.

`createInMemorySessionStore(...)` is useful for embedded hosts, tests, and
short-lived runtimes that do not want file persistence.

`createSourceWorkspaceProvider(...)` reads workspace markdown directly.
`createMultiWorkspaceProvider(...)` can route multiple workspace providers
through one `WorkspaceProvider` port. Capability skill mappings and Markdown
come only from the selected packages under `plugins/`.
