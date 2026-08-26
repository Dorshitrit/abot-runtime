# Model Gateway

`model-gateway` owns model invocation transport and provider mapping. Runtime
callers provide intent such as `modelStep`, `agentMode`, `modelOverride`, and
later `modelPreference`; the gateway resolves that intent to a provider payload.

Model selection precedence is:

1. configured `modelPolicy` only when
   `modelPolicy.defaults.overrideClientPreference` is `true`
2. client `modelPreference`
3. configured `modelPolicy.defaults.steps`, runtime role defaults, and the
   configured global `profileId`

`agentMode` is an effort/reasoning signal (`fast`, `reasoning`, `deep`), not a
public config key for model routing. Host apps should route models through
profiles, roles, exact `modelStep` entries, or the request `modelPreference`.
An explicit `modelOverride` changes only the concrete provider model on the
selected configured profile; it never invents a provider or profile. At least
one provider and profile must be configured, and resolution fails explicitly
when no valid configured profile can be selected.

Runtime roles derived from `modelStep` come from the shared model invocation
step registry. The gateway should not maintain its own step-prefix taxonomy.
When adding an internal model call, register its step metadata in
`src/shared/model-step-registry-data.json`; then gateway policy can resolve the
role/lane through shared lookup code.

`invocation-profile-policy.ts` is the shared selection boundary for step, role,
default, and client-preference profile precedence. Provider invocation and
runtime capability checks should use this resolver instead of reimplementing
profile selection.

Profiles may declare provider, generation, and context policy:

```json
{
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
      "generation": {
        "reasoningEffort": "medium"
      },
      "context": {
        "formatTokenAccounting": {
          "mode": "estimate",
          "fixedOverheadTokens": 0
        }
      }
    }
  }
}
```

Every materialized model profile must declare `contextWindowTokens` at the
profile root. It is the physical context-window capacity used for admission and
provider projection; invocation profiles and calibration slots cannot override
it.

`formatTokenAccounting` is provider-neutral. Omission defaults to `estimate`
with zero fixed overhead. `none` disables all format-token charges for a
transport that does not inject the structured schema. In `estimate` mode,
`fixedOverheadTokens` adds a non-negative transport-specific charge only when
a structured format is present.

Model profiles may define `calibration` slots for semantic runtime steps. The
request-runner config maps each `modelStep` id to a slot id; the gateway then
applies the selected model's own `generation`, `context`, `format`, or short
slot-specific `instructions` overlay without changing the provider/model
definition:

```json
{
  "profiles": {
    "default": {
      "model": "replace-with-model-id",
      "contextWindowTokens": 128000,
      "calibration": {
        "supervisor.decision": {
          "format": "json",
          "instructions": [
            "Choose the next delegated role or respond to the user."
          ]
        }
      }
    }
  },
  "defaults": {
    "steps": {
      "supervisor.decision": "supervisor.decision"
    }
  }
}
```

Legacy invocation profiles remain supported. They reference a model profile and
may override per-invocation `generation`, `context`, or `format`:

```json
{
  "invocationProfiles": {
    "transition-json": {
      "profileId": "default",
      "generation": {
        "temperature": 0.2
      },
      "format": "json"
    }
  },
  "defaults": {
    "steps": {
      "supervisor.decision": "transition-json"
    }
  }
}
```

If a `steps`, `roles`, or `profileId` value matches an invocation profile id,
the gateway applies that legacy invocation overlay. If a `steps` value does not
match an invocation profile or model profile id, it is treated as a calibration
slot on the selected model profile.

Provider-specific request builders translate only the shared controls that the
transport owns. The shared `generation` contract has no output-cap field, so
there is no configurable or calibrated per-step output cap. Ollama maps
`temperature` and `topP` to `options`, and supplies a finite `num_predict`
from the physical context remaining after the final projected provider input.
For a strict bounded JSON schema with thinking disabled, the smaller
schema-derived ceiling is used. Raw and unbounded outputs receive the physical
remainder. Provider-native `options.num_predict` remains available, and
`OLLAMA_NUM_PREDICT` remains its explicit environment override. Ollama maps the
profile's effective `contextWindowTokens` to `options.num_ctx` on every chat
and raw request. A configured
`options.num_ctx` may select a lower stable allocation, but calibration cannot
change either the declared physical capacity or that allocation.
`outputReserveTokens` is runner-owned input headroom only; it is never
forwarded as a provider output-token cap.
`models.providers.<id>.keepAlive` configures Ollama `keep_alive`. OpenAI uses
the Responses API and reads the API key from the configured env var.
Set `apiKeyEnv` to an environment variable name such as `OPENAI_API_KEY`, not
to the API key value.
New external-provider profiles do not inherit Ollama sampling defaults.
For OpenAI reasoning profiles, the gateway sends `reasoning.effort` and omits
`temperature`/`top_p` unless reasoning is explicitly disabled with `none`.
Each `/chat` or `/raw` call writes `model.invocation.resolved` to the runtime
debug log with the selected `profileId`, `provider`, concrete provider `model`,
and reasoning level. This is the authoritative log event for identifying which
model handled a request. Completed Ollama calls also write
`ollama.invocation.timing` internally with the effective `numCtx` and provider
load, prompt-evaluation, evaluation, total, and remaining durations. These
diagnostics do not enter the client event contract.

The HTTP gateway binds each `/chat` and `/raw` invocation to the lifetime of
its downstream client connection. A premature disconnect aborts the provider
fetch capability already injected into every adapter. If an adapter supplies
an additional fetch signal, the gateway composes it instead of replacing it.
Runtime timeouts, client cancellation, and other existing disconnect sources
therefore stop provider generation without changing the public adapter
contract.

Ollama streams also emit bounded internal `ollama.stream.progress` diagnostics
at exponentially increasing output sizes and one `ollama.stream.terminated`
summary. They record the effective `numPredict`, output-lane character counts,
elapsed time, and numeric repeated-suffix evidence without copying generated
text into the compact debug log. OpenAI emits the corresponding termination
summary. Cancellation propagation uses `provider.abort.requested` and
`provider.abort.propagated`. None of these diagnostics enter client events or
change provider-stream behavior.

Full provider I/O is written separately to
`.runtime/shared/logs/model-io.jsonl`. A `provider.request` entry contains the
exact provider payload after calibration instructions, message projection,
schema projection, and generation/context options have been applied. Its
matching `provider.response` entry contains readable assembled model output in
`response.decoded.text` and `response.decoded.thinking`, plus usage when the
provider reports it. The exact raw provider response remains available in
`response.body`. If a provider decoder raises an error,
`response.decodeError` records it without discarding that raw evidence. Both
entries share a unique `invocationId` as well as the runtime `requestId` and
`modelStep`. Provider credentials are deliberately excluded because they are
transport secrets, not model-visible input.

The full trace follows `logging.enabled` and uses the same
`logging.rotation` limits as the runtime debug logs, but has its own file and
write queue. `MODEL_GATEWAY_MODEL_IO_TRACE_FILE` may override its path. The
trace can contain complete prompts, conversation history, schemas, tool
observations, and image payloads; treat the bounded files as sensitive runtime
state.

## Provider adapters

Provider protocols are isolated behind `ModelProviderAdapter`. Gateway routing,
profile selection, HTTP endpoints, and tracing do not branch on provider names.
An adapter owns its authentication, request projection, response collection,
streaming semantics, diagnostics, and capability declaration. A host can append
adapters to the built-in Ollama/OpenAI registry:

```ts
import {
  createModelGatewayServer,
  type ModelProviderAdapter,
} from "@abot-ai/runtime/model-gateway";

const provider: ModelProviderAdapter = {
  type: "my-provider",
  supportsImageInput: false,
  async invoke({ endpoint, invocation }) {
    return endpoint === "chat"
      ? {
          kind: "chat",
          async stream(events) {
            events.emit({ type: "content", text: "..." });
            events.emit({ type: "done", done: true, doneReason: "stop" });
          },
        }
      : { kind: "raw", body: { text: "...", model: invocation.model } };
  },
};

createModelGatewayServer({ additionalProviderAdapters: [provider] });
```

The corresponding runtime config uses the adapter's `type` and may carry
adapter-owned JSON-safe values in `settings`. Unknown adapter ids fail
explicitly; they never fall back to Ollama or OpenAI.

Adapters may also expose the optional `countInputTokens` capability. The
gateway publishes it through `POST /input-tokens` and returns the count together
with the resolved profile, provider, model, and context-window binding. The
OpenAI adapter uses the official Responses input-token endpoint. Providers that
do not implement the capability remain on the runtime's existing estimator
path; in particular, Phase 1 does not change Ollama requests or payloads.

## Source layout

The files at the package root are stable public entry points and compatibility
facades. Implementation ownership is grouped by topic:

- `client/`: `/chat`, `/raw`, and `/input-tokens` transports, message
  projection, stream consumption, invocation metrics, and client options.
- `server/`: HTTP routing, request validation, provider invocation, abort
  propagation, administration endpoints, and response mapping.
- `policy/`: profile selection, invocation overlays, model resolution, and the
  public model registry.
- `providers/`: the provider contract and registry plus isolated `ollama/` and
  `openai/` protocol implementations.
- `protocol/`: provider-neutral message and usage contracts.
- `structured-output/`: format validation, provider projections, and schema
  budget estimation.
- `observability/`: model I/O tracing, provider traces, and context-window
  guards.

Tests live beside the implementation area they protect. Provider-specific
code must stay below its provider directory; package-root facades must not
accumulate implementation logic.

Keep orchestration decisions in `src/runtime`. Keep provider names, options,
thinking support, and model-profile selection in this layer.
