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

`BRAVE_SEARCH_API_KEY` is optional. The bundled Web plugin always exposes
`web_fetch` and `web_search`. A non-empty key selects Brave Search; without one,
`web_search` uses Light search over a limited catalog of public Hebrew and
English sources. Light reads those sources directly without an external search
engine. A failing configured key does not silently switch providers. The key
never belongs in runtime JSON or a plugin manifest.

Light uses the Web plugin's defaults and an in-memory cache; no background
crawler or separate service is installed. See
[Known Limitations](known-limitations.md#web-search) for its coverage and limits.

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

## Passive Long-Term Memory

Passive cross-session memory is opt-in. The default is equivalent to:

```json
{
  "longTermMemory": {
    "enabled": false,
    "emitClientEvents": false
  }
}
```

Enable it through the shared Web UI or CLI onboarding flow whenever possible:

```bash
npm run memory -- enable --provider <provider-id> --model <embedding-model-id>
```

The flow creates a dedicated `models.embeddingProfiles` entry, performs a real
embedding probe, validates the full config, and then atomically enables
`longTermMemory`. A manual equivalent is:

```json
{
  "models": {
    "embeddingProfiles": {
      "memory-embedding": {
        "provider": "ollama",
        "model": "<embedding-model-id>"
      }
    }
  },
  "longTermMemory": {
    "enabled": true,
    "emitClientEvents": false,
    "embeddingProfileId": "memory-embedding"
  }
}
```

The referenced provider must already exist under `models.providers`. Embedding
profiles accept `provider`, `model`, optional `label`, and optional JSON-safe
`options`. Generation, reasoning, context-window, and output-budget fields are
rejected because embedding and response-generation profiles have different
contracts.

`emitClientEvents` exposes bounded lifecycle status and counts, never memory
content or vectors. See [Passive Long-Term Memory](long-term-memory.md) for
storage, privacy, retrieval, and management behavior.

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
the process working directory. The referenced file owns model-step routing
overrides, timeout defaults and overrides, and the request context budget.
Fresh configurations use request-runner schema version 2:

```json
{
  "schemaVersion": 2,
  "models": {
    "defaults": {
      "profileId": "default",
      "steps": {
        "supervisor.response": "default",
        "worker.result": "default",
        "execution.response": "default",
        "tool_payload.raw": "toolPayload.raw"
      }
    }
  },
  "context": {
    "outputReserveTokens": 4096,
    "safetyReserveTokens": 1200,
    "attachmentReserveTokens": 1024
  },
  "stepDefaults": {
    "timeoutMs": 90000
  },
  "steps": {
    "supervisor.response": {
      "instructionRefs": [
        "../methodologies/response-ux.md",
        "../methodologies/memory-informed-response.md"
      ]
    },
    "execution.response": {
      "instructionRefs": [
        "../methodologies/response-ux.md",
        "../methodologies/memory-informed-response.md"
      ]
    }
  }
}
```

In schema version 2, `models.defaults.steps` is a sparse override map. A
missing model-step mapping resolves to the same id as the step, so an identity
entry such as `"capability.controls": "capability.controls"` is unnecessary.
The four entries above are the canonical non-identity overrides: three raw
response steps use the base `default` profile, while `tool_payload.raw` uses
the existing `toolPayload.raw` calibration slot. An explicit target may still
select a model profile, invocation profile, or calibration slot; an unknown
explicit target is rejected rather than replaced with a default.

`stepDefaults.timeoutMs` supplies the timeout for every step. The root `steps`
object is also sparse: add `timeoutMs` only when a step differs from the
default, and add `instructionRefs` only when that step needs additional
instructions. A missing step entry therefore uses the default timeout and has
no additional instruction references.

A request-runner config with no `schemaVersion` is the legacy v1 format
published with ABot 1.0.0. It remains supported and is normalized in memory;
the loader does not rewrite it, and adding a runtime model step does not require
the user to add a new identity mapping. `schemaVersion: 2` is the only explicit
supported version. Any other explicit value is rejected before the config is
used or written.

A fresh `abot init` creates schema version 2. Running init against an existing
project without `--force` preserves its request-runner config byte for byte,
including a legacy v1 file. Package upgrades never run a config migration or
rewrite automatically; `--force` remains an explicit request to replace the
local starter files.

Every materialized model profile declares its physical context capacity with
top-level `contextWindowTokens`. The selected profile supplies that capacity;
the request-runner context block supplies only admission headroom.

`outputReserveTokens` is input headroom for the runtime context manager. It is
subtracted while projecting messages so the prompt does not consume the whole
context window; it is never forwarded to a provider as an output limit. Model
steps may vary their prompt contract, timeout, format, or other generation
controls, but configuration does not define a shared per-step output-token cap.
The Ollama adapter still sends a finite provider-native `num_predict`, derived
mechanically from the final provider input and the physical context remainder.
Registered core-decision steps additionally retain their internal output-token
limit. Output schema size does not impose another generation limit; schema
projection, validation, input estimation, and compaction remain unchanged.

The required context fields remain explicit. Unknown fields, unknown step ids,
and invalid explicit overrides are rejected during configuration loading;
omitting a mapping or step entry uses the schema version 2 defaults described
above. `instructionRefs` are resolved relative to the request-runner config.
The `abot init` command installs the two default root-response methodologies
beside the local configuration, and the same references are applied to
`supervisor.response` and `execution.response`. They are presentation guidance
only and cannot alter the available actions, output contract, or runtime
authority.
`worker.result` is a raw-text authoring step. The canonical override selects the
base `default` profile without changing the step's distinct runtime identity;
an installation may still configure a more specific explicit target.
`planner.decision` remains the delegated MAIN Planner contract and keeps its
configured methodology references. `planner.graph` is the separate structured
graph proposal/decline contract used by the Execution Agent advisory Planner;
it receives its own normalized mapping, timeout, output contract, and model
calibration and does not inherit `planner.decision` instruction references.
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

The request-runner config maps internal `modelStep` ids only when a target
differs from the schema version 2 identity default:

```json
{
  "models": {
    "defaults": {
      "steps": {
        "tool_payload.raw": "toolPayload.raw"
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

| Step family                     | Slots                                                                                                                                                                 | Tune first                                                                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing and decisions           | `supervisor.decision`, `worker.decision`, `planner.decision`, `planner.graph`, `reviewer.decision`, `execution.decision`, `auditor.decision`, `degraded.finalization` | Keep the required structured `format`, then verify complete structured output and deterministic sampling. Add short model-specific instructions only when measured behavior needs them. |
| Capability control authoring    | `capability.controls`                                                                                                                                                 | Preserve the structured controls contract without applying the short decision-output ceiling.                                                                                           |
| User-facing or delegated output | `supervisor.response`, `worker.result`, `execution.response`                                                                                                          | Sampling and any intentional provider-native output controls. Do not force JSON unless that step's contract requires it.                                                                |
| Context compaction              | `context.compact`                                                                                                                                                     | Structured format and preservation of facts that later steps still require; physical capacity remains profile-owned.                                                                    |
| Literal tool payloads           | `toolPayload.raw`                                                                                                                                                     | Literal-payload instructions and any intentional provider-native output controls. Verify the produced payload or artifact directly, not the model's description of it.                  |

`timeoutMs` addresses provider latency only; raising it does not improve model
reasoning. Top-level `contextWindowTokens` declares the concrete model
profile's physical capacity. Calibration context fields can tune projection
policy but cannot override it. `generation` fields are provider-normalized,
but a provider may intentionally omit unsupported sampling fields, such as
temperature for an enabled OpenAI reasoning mode.

An omitted slot inherits the model profile's base generation and context. The
packaged schema version 2 request-runner example lists only the four canonical
non-identity overrides; all other steps resolve to their matching calibration
slot automatically. Most users therefore only need to edit the profile file
for the model they are tuning.

## Schema

The JSON schema is published as:

```ts
import schema from "@abot-ai/runtime/runtime.config.schema.json";
```

From source, regenerate it with:

```bash
npm run build-config-schema
```
