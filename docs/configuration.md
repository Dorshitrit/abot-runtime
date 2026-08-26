# Configuration

The default runtime host reads configuration in this order:

1. built-in defaults
2. `runtime.config.json`, or the file named by `LLM_RUNTIME_CONFIG_FILE`
3. supported environment variables

For local development, prefer:

```bash
npm run init -- --provider ollama --model <model-id>
```

`local/runtime.config.json` is ignored by git. Keep machine-specific URLs,
local paths, and profile choices there. The provider, concrete model id, and
default profile are required configuration; the runtime does not supply a
built-in model choice.

## Secrets

Do not put secret values in JSON config. Store them in `.env`, service
environment, CI secrets, or the host secret manager.

Common environment variables:

```bash
OPENAI_API_KEY=
BRAVE_SEARCH_API_KEY=
AGENT_BRIDGE_TOKEN=
LLM_RUNTIME_CONFIG_FILE=local/runtime.config.json
```

`BRAVE_SEARCH_API_KEY` is optional for startup and URL fetching. The bundled
Web plugin always exposes `web_fetch` and `web_search`; invoking `web_search`
without a non-empty key returns a clear plugin configuration error without
making a search request. The key never belongs in runtime JSON or a plugin
manifest.

Provider configs should reference env var names:

```json
{
  "models": {
    "providers": {
      "openai": {
        "type": "openai",
        "apiKeyEnv": "OPENAI_API_KEY"
      }
    },
    "profiles": {
      "default": {
        "provider": "openai",
        "model": "replace-with-model-id",
        "contextWindowTokens": 128000,
        "capabilities": {
          "inputModalities": ["text", "image"],
          "outputModalities": ["text"]
        }
      }
    }
  }
}
```

Ollama and OpenAI adapters are included. A host may register another adapter
through `@abot-ai/runtime/model-gateway`; its config uses that adapter's `type` and
may place adapter-owned JSON-safe values under `settings`. Merely naming an
unknown type never selects a fallback provider.

The setup commands recommend the Execution Agent policy for OpenAI profiles
and write it automatically to the generated model config:

```json
{
  "provider": "openai",
  "model": "replace-with-model-id",
  "contextWindowTokens": 128000,
  "execution": {
    "policy": "execution-agent-v1"
  }
}
```

Use the same block when configuring an OpenAI model profile manually. Other
providers are not implicitly assigned this policy by the initializer.

## Paths

`environment.paths.runtimeDir` is environment-local generated runtime state.
`environment.paths.attachmentsDir` stores runtime-managed attachment files
referenced by session/request metadata. Images and supported document files
share this store; document contents are read on demand by a request-bound tool
rather than copied into model context.
`environment.paths.sharedDir` is generated state shared across runtime
environments.
`environment.paths.compiledDir` is for optional generated context artifacts.
`environment.paths.workspaceDir` is the optional workspace context source.
`environment.paths.agentWorkDir` is the primary root for files created or
modified by plugins. Relative plugin paths and `.` resolve beneath that
configured directory; there is no fixed `sandbox/` alias.

Typical local layout:

```json
{
  "environment": {
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
      }
    }
  }
}
```

## Environments

Use `environment.profiles` to isolate live state for `prod`, `dev`, or another
host-defined environment:

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
          "agentWorkDir": ".runtime/prod/agent-work"
        }
      },
      "dev": {
        "paths": {
          "runtimeDir": ".runtime/dev",
          "agentWorkDir": ".runtime/dev/agent-work"
        }
      }
    }
  }
}
```

Select a profile with:

```bash
LLM_RUNTIME_PROFILE=dev npm run dev
```

The active profile id becomes the runtime id used by the bridge.

## Request Runner

The runtime config owns host wiring, installed models, and plugin availability.
Plugin manifests own capabilities and implementation defaults. Runtime config
delegates model-step policy and request context budgets to one required
request-runner config:

```json
{
  "requestRunner": {
    "configRef": "./request-runner.config.json"
  }
}
```

`requestRunner.configRef` is resolved relative to the runtime config file, not
the process working directory. The referenced file owns the complete set of
runtime model-step mappings and timeouts plus the request context budget:

```json
{
  "models": {
    "defaults": {
      "profileId": "default",
      "steps": {
        "supervisor.decision": "supervisor.decision",
        "supervisor.response": "supervisor.response",
        "planner.decision": "planner.decision",
        "planner.graph": "planner.graph",
        "worker.decision": "worker.decision",
        "worker.result": "supervisor.response",
        "reviewer.decision": "reviewer.decision",
        "degraded.finalization": "degraded.finalization",
        "execution.decision": "execution.decision",
        "execution.response": "execution.response",
        "auditor.decision": "auditor.decision",
        "context.compact": "context.compact",
        "tool_payload.raw": "toolPayload.raw"
      }
    }
  },
  "context": {
    "outputReserveTokens": 4096,
    "safetyReserveTokens": 1200,
    "attachmentReserveTokens": 1024
  },
  "steps": {
    "supervisor.decision": { "timeoutMs": 90000 },
    "supervisor.response": { "timeoutMs": 90000 },
    "planner.decision": { "timeoutMs": 90000 },
    "planner.graph": { "timeoutMs": 90000 },
    "worker.decision": { "timeoutMs": 90000 },
    "worker.result": { "timeoutMs": 90000 },
    "reviewer.decision": { "timeoutMs": 90000 },
    "degraded.finalization": { "timeoutMs": 90000 },
    "execution.decision": { "timeoutMs": 90000 },
    "execution.response": { "timeoutMs": 90000 },
    "auditor.decision": { "timeoutMs": 90000 },
    "context.compact": { "timeoutMs": 90000 },
    "tool_payload.raw": { "timeoutMs": 90000 }
  }
}
```

Every materialized model profile declares its physical context capacity with
top-level `contextWindowTokens`. The selected profile supplies that capacity;
the request-runner context block supplies only admission headroom.

`outputReserveTokens` is input headroom for the runtime context manager. It is
subtracted while projecting messages so the prompt does not consume the whole
context window; it is never forwarded to a provider as an output limit. Model
steps may vary their prompt contract, timeout, format, or other generation
controls, but they do not receive a shared per-step output-token cap.
The Ollama adapter still sends a finite provider-native `num_predict`, derived
mechanically from the final provider input, the physical context remainder,
and a strict bounded output schema when one applies.

All three root fields and every invoked step are required. Unknown fields,
missing steps, and extra step ids are rejected during configuration loading.
`worker.result` is a raw-text authoring step. It may reuse a model profile's
existing raw-response calibration slot, as shown above, without changing its
distinct runtime identity.
`planner.decision` remains the delegated MAIN Planner contract and keeps its
configured methodology references. `planner.graph` is the separate structured
graph proposal/decline contract used by the Execution Agent advisory Planner;
it has its own mapping, timeout, output contract, and model calibration and does
not inherit `planner.decision` instruction references.
The request runner has no configurable role hierarchy or fixed sequence. A
model profile may select one code-owned execution policy; omission uses the
current Supervisor/Worker behavior:

```json
{
  "execution": {
    "policy": "supervisor-worker-v1"
  }
}
```

`execution.policy` is runtime-only metadata. It is resolved once from the
canonical primary model profile, frozen for the request, and never forwarded
to the model gateway or provider. Registered values are:

- `supervisor-worker-v1`: the behavior-compatible Supervisor root with
  optional Planner, Worker, and Reviewer calls; this is the default.
- `execution-agent-v1`: an Execution Agent root that may execute capabilities
  directly and may use its registered advisory contracts.

Both policies use the same request kernel, role-call ledger, reducer,
capability engine, persistence, and finalization. Unknown values fail
configuration loading. The field selects a registered contract policy, not an
ordered workflow or a runtime-authored semantic sequence.

## Plugin Availability

Every installed capability is declared by a package under `plugins/`. The root
runtime config only enables or filters that catalog:

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["*"],
    "deny": ["filesystem.read_file"]
  }
}
```

`allow` and `deny` accept `*`, a plugin id, a capability id, or
`plugin-id.capability-id`; `deny` wins. An omitted or empty `allow` list also
selects the installed catalog. Tool contracts, implementation defaults,
secrets declarations, and skill bindings remain in each plugin package.
Runtime orchestration does not hardcode concrete tool names or use the catalog
to classify the user request.

For public or multi-model installs, keep each model's detailed calibration in a
separate model profile file instead of expanding the main runtime config:

```json
{
  "models": {
    "providers": {
      "ollama": {
        "type": "ollama",
        "baseUrl": "http://127.0.0.1:11434"
      }
    },
    "profiles": {
      "default": {
        "configRef": "./models/default.config.json"
      }
    }
  }
}
```

`models.profiles.<id>.configRef` is resolved relative to the runtime config
file. The referenced model file defines the provider model name, base
generation settings, physical context capacity, context-projection settings,
capabilities, and optional per-model calibration slots:

```json
{
  "label": "Replace with your model",
  "provider": "ollama",
  "model": "replace-with-model-id",
  "contextWindowTokens": 32768,
  "execution": {
    "policy": "supervisor-worker-v1"
  },
  "generation": {
    "temperature": 1,
    "topP": 0.95
  },
  "context": {
    "formatTokenAccounting": {
      "mode": "none"
    }
  },
  "calibration": {
    "supervisor.decision": {
      "generation": {
        "temperature": 0.15
      },
      "format": "json",
      "instructions": ["Return one valid Supervisor decision object."]
    }
  }
}
```

`context.formatTokenAccounting` is independent of provider identity. Omission
defaults to `estimate` with zero fixed overhead. Use `none` only when the
transport does not inject the structured schema; in `estimate` mode an
optional non-negative `fixedOverheadTokens` is added only when a structured
format is present.

`contextWindowTokens` is profile-level physical metadata. Calibration and
invocation-profile context overlays may tune provider-neutral format accounting
and token estimation, but they cannot change that capacity.

`context.maxConversationMessages` is not supported. Current-session history is
managed by the runtime as a persisted semantic checkpoint plus a protected tail
of ten complete user-agent turns. Removing the old cap prevents silent history
loss before a checkpoint covers those turns.

`context.maxToolObservationMessages` and `context.artifactContextMode` are not
supported. Tool observations and artifact context are projected by their
owning runtime contracts; model profiles cannot override those boundaries.

The request-runner config maps internal `modelStep` ids to semantic calibration
slot ids:

```json
{
  "models": {
    "defaults": {
      "steps": {
        "supervisor.decision": "supervisor.decision"
      }
    }
  }
}
```

Resolution is intentionally model-first: the request-runner default selects the
base model profile, and each mapped slot applies that model's own calibration.
Keep provider/model identity in the runtime model catalog, step selection in
`request-runner.config.json`, and per-model generation/context overlays in the
model profile file.

### Calibrating A Model By Step

A successful provider connection proves that the runtime can call the model;
it does not prove that the model is well calibrated for every semantic step.
Runtime schema, authority, timeout, and state guards keep execution safe, but
they cannot compensate for a physical context window that cannot admit required
context, provider-native output behavior that truncates JSON, or sampling
settings that make a small model unreliable.

Treat calibration as part of the exact model profile. Two profiles may expose
the same step names while needing different values. Do not copy settings from a
small local model to a hosted reasoning model, or the reverse, without
measuring the result. Selecting `execution.policy` is a separate architecture
choice; do not change the policy merely to hide a calibration problem.

Use this bounded workflow:

1. Start with the generic profile and the exact provider model id that will be
   used in production.
2. Run one representative request and locate the failing `modelStep` in the
   `model.invocation.resolved` debug event. When the failure is unclear, find
   the provider trace by `requestId` and `modelStep`, then pair its
   `provider.request` and `provider.response` entries by `invocationId`.
3. Change only that profile's matching calibration slot. Adjust one class of
   setting at a time: generation, context, format, instructions, or timeout.
4. Repeat the same request and compare observable output, structured events,
   and required artifacts. Keep a change only when it produces a measurable
   relevant improvement without a regression.
5. Test nearby inputs after the focused case passes. A calibration that solves
   one prompt by encoding its wording is not a reusable model calibration.

The common slots and their first tuning targets are:

| Step family                     | Slots                                                                                                                                                                 | Tune first                                                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing and decisions           | `supervisor.decision`, `worker.decision`, `planner.decision`, `planner.graph`, `reviewer.decision`, `execution.decision`, `auditor.decision`, `degraded.finalization` | Keep the required structured `format`, then verify complete structured output and deterministic sampling. Add short model-specific instructions only when measured behavior needs them. |
| User-facing or delegated output | `supervisor.response`, `worker.result`, `execution.response`                                                                                                          | Sampling and any intentional provider-native output controls. Do not force JSON unless that step's contract requires it.                                                    |
| Context compaction              | `context.compact`                                                                                                                                                     | Structured format and preservation of facts that later steps still require; physical capacity remains profile-owned.                                                       |
| Literal tool payloads           | `toolPayload.raw`                                                                                                                                                     | Literal-payload instructions and any intentional provider-native output controls. Verify the produced payload or artifact directly, not the model's description of it.     |

`timeoutMs` addresses provider latency only; raising it does not improve model
reasoning. Top-level `contextWindowTokens` declares the concrete model
profile's physical capacity. Calibration context fields can tune projection
policy but cannot override it. `generation` fields are provider-normalized,
but a provider may intentionally omit unsupported sampling fields, such as
temperature for an enabled OpenAI reasoning mode.

An omitted slot inherits the model profile's base generation and context. The
packaged request-runner example already maps each semantic step to its matching
calibration slot, so most users only need to edit the profile file for the
model they are tuning.

## Schema

The JSON schema is published as:

```ts
import schema from "@abot-ai/runtime/runtime.config.schema.json";
```

From source, regenerate it with:

```bash
npm run build-config-schema
```
