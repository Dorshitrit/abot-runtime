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
transport owns. `ResolvedModelInvocation.think` is exact: an adapter must map
`none` to its native disabled form or fail explicitly; only `undefined` permits
omission. The shared `generation` contract has no output-cap field, so
there is no configurable or calibrated per-step output cap. Ollama maps
`temperature` and `topP` to `options`, and supplies a finite `num_predict`
from the physical context remaining after the final projected provider input.
Registered core-decision steps also apply their shared output-token limit.
A strict JSON schema never lowers this allowance: schema shape does not bound
legal JSON whitespace or serialized escaping and therefore cannot establish a
safe provider token ceiling. Schema projection and validation remain unchanged.
Provider-native `options.num_predict` remains available, and
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
`supportsThinking` declares support for explicit reasoning controls; it is not
the user's reasoning preference. An omitted declaration does not disable reasoning.
llama.cpp may also configure `generation.reasoningBudgetByMode` with non-negative
`fast`, `reasoning` and `deep` token limits. A matching main-lane mode limit
overrides the generic budget. Zero disables thinking; a positive mode limit enables
it, including for Low. Explicit invocation/request controls remain authoritative. Utility steps ignore the map.
Generation overlays replace the complete map; `{}` removes inherited mappings.
Manual token budgets and server-default preferences preserve a positive effective
effort; they enable `medium` only when the ordinary effort is `none`. Explicit
request Off and invocation effort overrides retain their existing precedence.
A selected token budget of `0` is equivalent to Off without changing the stored
effort. An explicit positive invocation effort still overrides Off and drops the
zero limit. llama.cpp receives `reasoning_effort: none`, `enable_thinking: false`
and `reasoning_budget_tokens: 0` for disabled reasoning.
`agentMode`, `reasoningOverride`, and calibrated `generation.reasoningEffort`
select the requested effort. Without declared control support, the adapter leaves
reasoning to the provider rather than claiming that it disabled it.
For OpenAI profiles with declared reasoning controls, the gateway sends the resolved
`reasoning.effort`, including explicit `none`, and omits `temperature`/`top_p`
unless reasoning is disabled with `none`.
OpenAI's `max_output_tokens` counts both reasoning and visible output. The
gateway omits this parameter for all reasoning levels and model steps, including
explicit `reasoning.effort=none`. LOW (wire value `fast`), REASONING and DEEP
select reasoning effort without adding a separate output cap. The provider enforces
output capacity; the input context guard and configured sampling controls retain their existing
semantics. This policy does not discover model capabilities or assume support
for a particular effort level.

For `capability.controls`, `execution.decision` and `context.compact` requests with an object JSON
schema, OpenAI receives one forced native function with that schema as its
parameters and parallel calls disabled. This carries the existing EA decision,
EA/SUPER controls or semantic-compaction envelope;
it does not expose tool handlers or grant execution authority. Only one matching
call from a completed response supplies its exact arguments to the existing
Runtime validators, decision parser, frozen-control merge and checkpoint validation as applicable.
No extra model invocation or decision is added. Canonical native tool history
retains its call/result identities and arguments. Commentary and argument deltas
remain provisional. Missing, duplicate, mismatched or malformed calls fail
explicitly; a truncated response,
EOF or `[DONE]` without a completed response cannot authorize execution.
Token counting includes the same function declaration as generation. Request
messages, reasoning, timeouts, retries, capability permissions and continuation
history keep their existing contracts. Non-schema gateway requests and other
steps retain their existing formatting. This transport is shared by Windows,
WSL, Linux and macOS; it does not depend on the host or a particular model name.

For structured OpenAI responses and `tool_payload.raw` content authoring, message
selection uses the provider's `phase` metadata and item identity. Only the selected
`final_answer` enters the decision validators or tool payload consumer; commentary
cannot become file content. Plain payload authoring keeps its plain-text provider
format, and existing tool validators still validate the selected bytes.
Final-answer deltas stream as soon as their phase is known. Text
without phase metadata waits for item or response metadata; if no phase is
provided anywhere, the first text message retains its legacy meaning. A response
must complete before its text can be accepted as a decision or tool payload; EOF
or `[DONE]` alone fails explicitly, even if the collected content is valid. Additional
messages are never concatenated into a decision or tool payload. A phase-labelled
response without `final_answer` reports an explicit stream error. This rule is
independent of reasoning effort and model name. Other unstructured text steps
keep their existing streaming behavior. Raw provider I/O retains preambles;
bounded selection diagnostics identify the chosen and ignored messages without
copying their text. No extra model call or JSON repair is introduced here.

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

If a provider stream throws after `/chat` has emitted an event, the gateway
ends that NDJSON response with an `error` event instead of attempting a second
HTTP response. The client rejects the partial answer; no success `done` event
is synthesized. Failures before the first event retain the existing HTTP error
response, and downstream cancellation remains silent.

Ollama streams also emit bounded internal `ollama.stream.progress` diagnostics
at exponentially increasing output sizes and one `ollama.stream.terminated`
summary. They record the effective `numPredict`, output-lane character counts,
elapsed time, and numeric repeated-suffix evidence without copying generated
text into the compact debug log. OpenAI emits the corresponding termination
summary. Cancellation propagation uses `provider.abort.requested` and
`provider.abort.propagated`. None of these diagnostics enter client events or
change provider-stream behavior.

The OpenAI HTTP response body ends locally when the existing normalizer accepts
`response.completed`, `response.incomplete`, `response.failed`, `error`, or `[DONE]`. This boundary
precedes tracing clones, so chat, raw collection and trace readers all finish
without waiting for the provider to close its connection. The upstream reader
is cancelled and released; asynchronous transport cleanup cannot delay the
accepted result. The trace retains received bytes through the chunk containing
the terminal frame. Message/item completion is not response completion. The
same SSE data framing serves lifetime detection and output decoding, including
LF, CRLF, CR, split UTF-8 and multiline data. Ordinary text retains partial-text
EOF behavior; structured decisions, native function output and tool payloads
require response completion. Existing max-output-token handling remains unchanged.

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

Response traces also record bounded stream diagnostics: time to headers and first/
last chunk, bytes received, SSE event counts, and the last 32 event types with
arrival times. A failed capture emits `provider.failure` with stage
`response.capture` and the same `response.stream` diagnostics. Its response
retains two bounded excerpts of the received raw bytes:

- `response.partialBodyPrefix`: the first at most 16 KiB. `partialBodyPrefixBytes`
  counts retained source bytes; `partialBodyPrefixTruncated` is true when
  `response.stream.bytesReceived` exceeds that count.
- `response.partialBody`: the last at most 16 KiB, preserving the existing tail
  contract. `partialBodyBytes` counts its retained source bytes; `bodyTruncated`
  is true when `response.stream.bytesReceived` exceeds that count.

The excerpts may overlap; when at most 16 KiB arrived, they contain the same
received bytes and both truncation flags are false. Those flags describe excerpt
bounds, not whether the provider completed its response. A failure before any
bytes arrive records empty excerpts, zero byte counts, and false flags.
Each excerpt is decoded as UTF-8 and may start or end inside a character or SSE
event; byte counts refer to source bytes before decoding, including any split
character rendered as a replacement character. These are diagnostic fragments,
never a completed model result or two pieces to concatenate into one result.
Successful responses retain their existing complete body and decoded output.
These records follow the existing logging and content-privacy gates and do not
change model output selection, timeouts, or retries.

SSE diagnostics count data-bearing frames only. The last explicit `event` field
wins (including an empty field, which means `message`). Without an explicit
event field, a complete newline-joined data payload supplies its JSON `type`
or the `[DONE]` marker; otherwise the type is `message`. Field values preserve
whitespace except for the protocol's optional single ASCII space after `:`.
Type names retain at most 128 characters. Lines and accumulated frame data each
retain at most 32,768 characters; oversized event lines still replace the prior
type using their retained prefix. Truncated data is never parsed as complete
JSON. `oversizedLineCount` reports dropped line suffixes; a frame exceeding the
aggregate data bound still counts, using its explicit type or `message`.
A raw capture failure is logged without waiting for the diagnostic decoder.

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

Input-token failures emit an internal `input_tokens.request.failed` diagnostic
at the client and gateway boundaries. It records the request/model-step binding,
failure phase, elapsed time, numeric input shape and any upstream HTTP status or
bounded request ID. Nested transport failures retain only error types and
allowlisted codes (including aggregate connection errors). Prompt text, schemas,
headers, response bodies, error messages and stacks are excluded. These records
do not add retries or change HTTP errors, cancellation, counting or cache behavior.

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
- `structured-output/`: format validation and provider projections.
- `observability/`: model I/O tracing, provider traces, and context-window
  guards.

Tests live beside the implementation area they protect. Provider-specific
code must stay below its provider directory; package-root facades must not
accumulate implementation logic.

Keep orchestration decisions in `src/runtime`. Keep provider names, options,
thinking support, and model-profile selection in this layer.
