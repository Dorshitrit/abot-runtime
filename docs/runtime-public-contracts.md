# Runtime Public Contracts

This document describes the stable runtime contracts that host applications can
depend on. It intentionally does not describe internal request execution,
role orchestration, model, or context modules.

## Public Entrypoints

Use package exports from `package.json`:

- `@abot-ai/runtime/runtime`
- `@abot-ai/runtime/runtime/config`
- `@abot-ai/runtime/runtime/composition`
- `@abot-ai/runtime/runtime/default-adapters`
- `@abot-ai/runtime/runtime/adapters`
- `@abot-ai/runtime/runtime/ports`
- `@abot-ai/runtime/plugin-sdk`
- `@abot-ai/runtime/model-gateway`

Do not import from `src/runtime/request`, `src/runtime/orchestration`,
`src/runtime/steps`, `src/runtime/model`, `src/runtime/context`, or
`src/runtime/events` in a host application. Those modules are internal and may
move while public ports remain stable.

## RuntimeDependencies

`createDefaultRuntimeDependencies(config)` returns the current default
composition:

- `config`
- `host`
- `sessions`
- `attachments`
- `tools`
- `models`
- `events`

Hosts may replace any dependency except `config` through
`RuntimeDependencyOverrides`.

## RuntimeHost

`RuntimeHost.start(options)` accepts the current runtime and adapter boundary:

- `runtimeConfig`
- `runtimeId`
- `agentBridgeUrl`
- `agentBridgeToken`
- `eventSinkFactory`
- `modelGatewayClient`
- `sessionStore`
- `attachmentStore`
- `toolRegistry`

Hosts may use `createDefaultRuntimeDependencies(config)` for default adapters or
inject their own ports. Injected ports are responsible for preserving the same
semantic contracts described below.

`conversationContextProvider`, `skillProvider`, and `workspaceProvider` are not
`RuntimeHostStartOptions`.

## SessionStore

`SessionStore` is the source of truth for durable session state. It owns:

- session records and snapshots
- user and assistant messages
- request stream lifecycle
- persisted request events
- request replay by `requestId`
- message deletion and session reset operations

Request event replay is append-only from the runtime perspective. Consumers
should treat event sequence order as meaningful and should not infer final
request success from a single event when later failure/completion events exist.

## RuntimeAttachmentStore

`RuntimeAttachmentStore` owns durable request attachment storage and
session-bound reference validation:

- `saveAttachment(input)`
- `validateAttachmentReferences(attachments, options?)`
- `resolveAttachment(attachment)`
- optional `deleteAttachment(attachment, options?)`
- `deleteSessionAttachments(sessionId)`

`createDefaultRuntimeDependencies(config)` exposes this port as
`runtime.attachments`; pass it to `RuntimeHost.start(...)` as
`attachmentStore`.

Attachment references use `kind: "image" | "file"`. Supported images continue
through the model vision input. Supported document files are exposed to the
request-bound `document_reader` capability by id/name; their binary payload is
never inserted into model context. The `local-search` plugin can search bounded
filenames or text only beneath configured agent-work and workspace roots.

## EventSink

`EventSink` is the UI/bridge event output boundary for one request. Stable
methods are:

- `publish(payload)`
- `event(name, extra)`
- `runtimeState(state)`
- `token(token)`
- `legacyToken(text)`
- `thinkingDelta(delta, accumulatedText)`
- `completed(output)`
- `failed(error, details)`
- `drain()`
- `dispose()`

`event(name, extra)` preserves the raw runtime event name in the payload while
UI-facing status helpers may add display-oriented names. Consumers that need
logic should key off raw event names and payload fields, not display strings.

Planner events follow snapshot-plus-diff semantics:

- `planner.plan.created` and `planner.plan.updated` carry the current plan
  snapshot.
- `planner.plan.item.*` events are timeline/update events for individual plan
  items.
- Planner payloads retain `stage=development_plan` for client compatibility.
  This field is presentation metadata and does not identify a runtime loop.

These events describe canonical delegated Planner state. A `planner.graph`
advisory under `execution-agent-v1` is a passive subordinate result and does
not create `planner.plan.*` state or events.

Runtime capabilities use the stable tool event envelope. Adapter-owned
presentation metadata supplies the tool, operation and action type; target
metadata contains only resolved logical paths. Physical
roots and opaque subject identities are never exposed. A plugin may opt into
bounded input or result excerpts through its declared event presentation.
These excerpts are display data, not additional model instructions or evidence.
These events describe capability execution only. Only `planner.plan.*` events
report canonical item-status changes or semantic progress.

Tool events use the current tool execution boundary:

- `tool.started`
- `tool.payload.started`
- `tool.payload.completed`
- `tool.payload.failed`
- `tool.completed`

A `tool.completed` event with `ok: true` proves only that the tool step
succeeded. It does not prove the user request is complete.

Registered-tool events may include an optional `executionId` shared by their
payload, approval and execution stages. Clients correlate with
`(requestId, executionId)` rather than matching tool names or arrival order.
Payload publication still occurs after canonical admission. Older events without
this field do not establish a lifecycle pairing.

The same adapter boundary may include `executorRole` and `roleCallId` from the
canonical role call. Clients can place the action under its executor even when
the active role has changed before completion. These fields are display identity;
they do not change runtime stages, tool parameters, approval inputs or evidence.
The root role identifier remains `supervisor` regardless of its selected contract.

`eventPresentation.resultMetadata` maps optional display keys to existing tool
result fields through `{path, kind}` descriptors. Paths select `output` or an
own-property path under `data` (at most four segments). Kinds are `preview`,
`number` and `boolean`, with at most 16 mappings. A preview is limited to 1,200
characters and 20 lines, with a 2,400-character total preview budget per event;
its companion `<key>Truncated` flag describes preview clipping, independently
of source-result truncation. Missing or mismatched fields are omitted. Valid
declared values take precedence over generic metadata; omitted fields retain
the existing fallback metadata. Projection
does not mutate tool results, canonical evidence, action references or model
context. The client renders excerpts as inert text and never reconstructs an
old result by re-reading the current file or memory store.

## ToolRegistry

`ToolRegistry` owns active tool capability discovery and execution:

- `listDefinitions(taskType?)`
- `getDefinition(name)`
- `getAdapter(name)`
- `hasToolsAvailable()`
- `getImplementations()`
- `execute(call, options?)`

Runtime orchestration must treat the registry as the capability authority. Tool
names, normal-invocation contracts, payload-channel specs, and plugin-provided
tools belong to the registry/tool layer, not to core orchestration. The frozen
execution policy determines whether the canonical Worker or root may bind an
offered capability; both principals use the same registry and adapter engine.

`ToolModule.adapter` is the tool-layer extension point for call-shape
normalization. Built-in tool packs and runtime plugin tools may provide an
adapter. The parser may invoke an adapter generically through the active
registry, but tool-specific aliases, compatibility rewrites, or routing from one
legacy tool shape to a current tool must live in the owning tool module or pack,
not in parser or runtime orchestration code.

## ToolDefinition And ToolExecutionResult

`ToolDefinition.routingCapability` and `developmentRoles` are tool metadata
retained for compatibility. They must not select a request path or role.
Model-facing availability and controls come from the registered
`normalInvocation` contract.

A normal-invocation contract accepts at most 32 operations. This bounds the
registered operation catalog; it does not limit invocation frequency or the
number of user-created scheduled Jobs.

Every plugin-handler return is normalized by `ToolRegistry` into one complete
`ToolExecutionResult`, whether the operation succeeds or fails. The selected
tool identity is Runtime-owned; plugins provide the operation result. The
public envelope contains:

- `ok`: execution success
- `tool`: the non-empty selected capability id added by `ToolRegistry`
- `output`: the textual operation result
- `progress`: step made runtime progress
- `producedNewInformation`: step revealed new information
- `actions`: tool-owned structured action summaries
- optional process and failure fields: `exitCode`, `stdout`, `stderr`, `error`,
  and `errorCode`
- `data.mutationEvidence`: tool observed or applied mutation evidence
- `data.stateAlreadySatisfied`: requested state was already satisfied
- `data.hasData`: inspection returned useful data
- `data.observationMeta`: carry policy for future request context

Failed execution does not count as progress. A successful tool step proves only
the reported result, not overall completion.

The complete result is a mandatory canonical evidence object. Before capability
settlement, the Runtime validates that it contains only plain JSON-safe data and
fits the 256 KiB serialized producer boundary. Functions, symbols, accessors,
cycles, non-plain prototypes, non-finite numbers, and oversized results fail
explicitly. The Runtime does not silently truncate, partially parse, or discard
structured fields.

The registered-tool adapter wraps the complete result as
`registered_tool_execution_result_v1`; Runtime-owned rejections and generic
adapters use their corresponding canonical envelopes. The capability engine
atomically settles the operation outcome and exactly one validated canonical
adapter result in the RoleCall ledger. A settled execution cannot omit that
evidence, and a running execution cannot carry it.

Exact result projection is bound mechanically to the producing call. A direct
root keeps its strict native assistant-tool-call / linked-tool-result lane. A
delegated Worker receives its own complete adapter result through
`runtime_request_tool_results_v1`, and later payload authoring in that same call
receives the same canonical evidence. Supervisors, Planners, Reviewers, sibling
Workers, unrelated calls, and unrelated requests receive only their existing
bounded receipts or child handoffs; the exact body is not copied to them.

This lifecycle is generic for every registered plugin and must not require
plugin-specific Runtime projection code. See
[tool-execution-result-evidence-contract.md](tool-execution-result-evidence-contract.md)
for the producer rules, lifecycle, authority boundary, compaction semantics,
and compatibility guarantees.

## SkillProvider

`SkillProvider` owns model-facing skill text:

- `getActionContext(action)`

The default provider projects this context only from the selected capability's
mapping in its loaded plugin manifest. It has no built-in, file-backed, or
composite skill source.

## WorkspaceProvider

`WorkspaceProvider.getSystemSummary()` provides host/workspace context. This is
context only; filesystem truth for a requested mutation or verification still
comes from tool execution results.

`WorkspaceProvider` and its public adapters remain standalone public contracts;
they are not `RuntimeHost.start(...)` options.

## ModelGatewayClient

`ModelGatewayClient` owns model invocation transport:

- `invoke(params)` for streamed/chat-style model steps
- `invokeRaw(params)` for raw payload generation

Callers provide intent fields such as `modelStep`, `agentMode`,
`modelPreference`, `modelPolicy`, and optional overrides. Model routing belongs
to the model gateway policy, not request orchestration.

Text-only message arrays retain their existing transport contract. When a
message array contains the native tool-interaction lane, it is strict: one
assistant message carries non-empty `toolCalls`, each exact call is followed in
order by its matching `role: "tool"` result, and call id, tool name, arguments,
and result content are not semantically rewritten. The gateway validates this
linkage before provider projection, and token accounting includes the complete
lane. `execution-agent-v1` uses this lane to resume the same canonical root
after direct capability settlement; it is not a second tool or evidence store.

## Runtime Completion Semantics

The canonical root alone owns request completion and the final user-facing
response. Its frozen model-facing contract is Supervisor under the omitted
default `supervisor-worker-v1` policy and Execution Agent under the opt-in
`execution-agent-v1` policy. Planner, Worker, Reviewer, and Auditor return
bounded results to their exact callers. The RoleCall ledger validates state
transitions; capability adapters establish only their reported operation
outcomes. No layer should combine these owners into a transcript-shaped
conditional or infer completion from one successful tool event.

The default policy keeps the established normalized final-text behavior.
`execution-agent-v1` alone selects exact terminal text mode: its committed
terminal string, including raw non-empty `execution.response` output, passes
through the same finalizer without trimming. This presentation choice does not
create a policy-specific persistence or completion path.

## Prompt And Policy Contracts

Prompt text parsed into a Supervisor, Execution Agent, delegated Planner,
Planner Graph, Worker, Reviewer, or Auditor action is part of the runtime
contract. Changing a role action, advisory result, or capability envelope is a
behavior change and requires coverage at its owning parser, ledger, or
capability boundary. `planner.graph` and `planner.decision` are distinct model
steps and contracts; neither is a compatibility alias for the other.

Prompt and policy ownership is tracked in
[runtime-prompt-policy-contracts.md](runtime-prompt-policy-contracts.md), and
runtime invariant coverage is tracked in
[runtime-invariant-coverage.md](runtime-invariant-coverage.md).

## Stable Consumer Rule

Host applications should depend on ports, config schema, event payloads, session
snapshots, request replay, tool definitions, and tool execution results. They
should not depend on internal file layout, prompt wording, private helper
functions, or display-only event labels.
