# Runtime

`src/runtime` contains the canonical request runtime. Every prompt enters one
request kernel. A model profile may select a registered model-facing contract
policy, but policies reuse the same ledger, reducer, root activation procedure,
subordinate-call mechanism, evidence, events, persistence, and finalization.
There is no separate Development, General, Tool, or profile-owned semantic
loop.

## Request Flow

The production path is:

1. `request/handler.ts` validates the client request, resolves the selected
   model profile and its execution policy once, opens the session, snapshots
   the settled conversation source, and creates request-scoped dependencies
   from that same compiled policy authority.
   Immediately after valid input, it also captures one immutable server-clock
   observation in the server's resolved IANA time zone. The same passive
   request-time reference is projected only to model steps that choose
   routing, plans, capabilities, or remaining controls. Presentation,
   result-authoring, payload-authoring, review, audit, compaction, and
   finalization steps do not receive it.
2. `request/runner.ts` consumes the frozen compiled policy, creates the
   canonical RoleCall ledger, attaches the client plan-event observer, creates
   the single canonical root, and starts the shared root kernel.
3. The selected root contract asks its model for the next semantic action.
   `supervisor-worker-v1` exposes the behavior-compatible Supervisor contract;
   `execution-agent-v1` exposes the Execution Agent contract and root-owned
   capability actions.
4. The role-executor registry mechanically opens the selected child, runs it,
   commits its result, and returns that result to the exact caller. A
   Supervisor or Planner that directly invokes a Worker may narrow that child
   to one or more request-scoped capability catalog groups; it never selects
   the concrete capability. A Supervisor may establish a canonical working
   directory on a Planner or Worker call. A Planner inherits that directory
   mechanically into every Worker child; only when its own call has no such
   scope does it select the Worker's directory. The runtime commits the result
   as the canonical base for relative manifest-owned operation targets.
5. An authority permitted by the frozen policy may select one or more
   capabilities from its effective request-scoped catalog. The shared binding
   executes them, commits the settled results, and resumes that same canonical
   call. Execution Agent results are projected through a provider-native,
   mechanically linked tool-call/result lane; the runtime does not select the
   next semantic action. Before its first direct capability execution, the
   kernel establishes one immutable normalized working directory on the root
   call from the accepted Execution Agent decision; an explicit `null`
   selection resolves to `.`.
6. Only the canonical root commits the root response. The selected contract
   may use its own presentation step, but the request finalizer, persistence,
   terminal observation, and completion path are shared.

While a request is active, the bridge may append ordered user steering
messages to its request-scoped inbox. The active root contract receives the
accumulated messages as user-authority context and decides their effect on the root
request. A bounded child role keeps its delegated objective unchanged, returns
its current result to its caller, and does not reinterpret steering as an
implicit expansion of that objective. A root output completed against an older
inbox version is discarded before a role, capability, ledger, or final-response
commit and is recomputed with the current messages. The runtime transports
these messages mechanically; their meaning remains a root-model decision.

The bridge and Web UI backend call `handleRunRequest(...)` through this path.
Do not add another runner, request classifier, profile router, or fallback
semantic loop.

## Code Lifetimes and Composition

`createRuntimeApplication(...)` is the primary composition root. It constructs
one frozen `RuntimeEnvironmentServices` graph, one bound request handler, and
one host. The older `createDefaultRuntimeDependencies(...)` shape remains a
compatibility facade; production startup, the bridge, and the Web UI reuse the
same service instances rather than rebuilding dependency bags per request.

Each accepted request is owned by one `RequestHandlingSession`. After input,
session, model, and policy resolution, it creates one immutable
`RequestExecutionScope` with named facets for identity, accepted input, session
snapshot, model runtime, lifecycle, presentation, policy, and capabilities.
Production request execution accepts only that canonical scope. Internal bound
views expose only the fields needed by model invocation or capability
execution, and one typed `RequestModelStepInvoker` is reused for the whole
request. Flat fixture construction is confined to test and private-probe
support, which must build the same canonical scope before invoking runtime
code.

Long procedures are split by lifetime and responsibility:

- `RootExecutionSession` owns the single root activation procedure.
- `RoleActivationLoop` and `ChildInvocationTransaction` run subordinate calls;
  they do not own independent continuation counters.
- `RoleCallTransactions` is the typed command/effect facade over the sole
  reducer and ledger writer.
- `BoundCapabilitySession` owns one call-bound capability facade while
  re-resolving live authority at every execution.
- `PayloadStageRunner`, `ModelStepInvocation`, and the gateway stream reader
  and accumulator own one payload, model, or transport attempt.

Request state is never stored in a module-level registry. Debug and model-I/O
trace queues are explicit process singletons for compatibility with the
existing single-process log routing; they are not request or environment
isolation boundaries.

## Roles and Authority

- **Canonical root** is the fixed request authority and the only principal
  that can answer the user. Its model-facing contract is selected once by the
  frozen execution policy.
- **Supervisor contract** preserves the delegated MAIN behavior: it chooses
  the next semantic action, consumes returned child results, and may select
  catalog groups for a directly invoked Worker.
- **Execution Agent contract** may invoke root-authorized capabilities
  directly and consumes their mechanically linked continuation before choosing
  its next action. It does not create a second root or state machine.
- **Delegated Planner contract** coordinates one bounded delegated objective.
  It declares every currently known execution outcome before its first child
  dispatch. Each Worker invocation binds exactly one independently completable
  production item; after consuming that bound result, a later activation may
  select the next pending production item. Planner invokes only Worker and
  represents the completed sub-process to Supervisor, which separately owns
  Reviewer delegation and audit decisions. For a Worker child, Planner selects
  only the smallest complete set of offered catalog groups; the Worker still
  owns capability and control selection.
- **Planner Graph advisory contract** may propose or decline one bounded
  dependency graph for the Execution Agent. It is a terminal passive child
  result: it cannot execute graph nodes, write canonical plan state, or commit
  completion.
- **Worker** performs one bounded objective. It may return a substantive result
  from supplied knowledge or invoke one offered capability when an external
  observation or effect is required. Its structured decision selects the
  action; substantive completion text is authored separately as raw text.
- **Reviewer** independently assesses bounded supplied work in the delegated
  policy and returns a human-readable summary plus a bounded, revision-bound
  `reviewer_verdict_v1` receipt to its exact caller. The receipt is passive
  canonical evidence; it does not choose remediation or finalization.
- **Auditor** receives typed criteria and whole canonical evidence entries in
  the direct policy. It returns a passive pass/gaps advisory; omitted evidence
  makes pass unavailable and the root still owns the next action.

A Planner Graph or Auditor structured-output validation failure settles as a
failed passive child result and returns to the root; it does not write plan
state, authorize execution, or commit request failure by itself.

Under `supervisor-worker-v1`, every terminal Planner or Worker result receives a
runtime-owned `work_result_v1` receipt. Supervisor and Planner continuations
receive that compact receipt together with a verified `work_result_lineage_v1`
projection; an explicitly dependent Worker receives only the compact receipt.
These structures prove canonical provenance, not semantic correctness, and do
not grant response, remediation, or capability authority. Model-supplied work
receipts are rejected. `execution-agent-v1` does not issue them.

Role choice belongs to the active role model. Runtime code validates the strict
action envelope, exact caller, role availability, current ledger head, and
global bounds; it does not infer work type from prompt text, paths, tool names,
or model prose.

## Canonical State

`orchestration/role-calls/` ledger v17 is the sole writer of the request-local call tree
and role results. Each call frame records its caller, role, bounded objective,
depth, status, result reference, and any canonical capability catalog-group
scope. An authorized root, Planner, or Worker may also record one normalized
working directory; the role-call reducer is the sole writer of that immutable
scope. A Planner's Worker children inherit it mechanically and cannot replace
it.
A result returns only to that exact caller. The ledger mechanically binds each
Supervisor-policy Planner or Worker result to its producer, caller, admitted
revision, and a lineage fingerprint. Full lineage is derived on demand from the
same ledger and verified against that fingerprint; it is not a second state
store and the compact receipt does not copy dependency, execution, or plan-item
lists.

The same reducer enforces one mechanical per-call activation ceiling for every
root and delegated call. The ceiling is derived from the existing request-wide
call and capability-execution limits; model steps, role loops, providers, and
tools do not maintain separate counters or retry policy. An over-budget
transition is rejected before commit as `role_activation_limit_exceeded`.

`orchestration/worker-capabilities/` is the shared capability engine retained
for compatibility; its policy-neutral binding attaches offered descriptors and
executions to the exact authorized call and activation, including a root call
when the frozen policy permits it. Capability adapters execute concrete
operations and report bounded settled facts; they do not select roles, declare
overall completion, or write the final response.

Worker-owned and root-owned capabilities use the same `tool_payload.raw`
payload author. The author validates the active principal against the frozen
policy authority. The delegated Worker keeps its established assignment
capsule; a direct root payload binds the exact request source, ordered steering,
and immutable controls. Capability `intent` is bounded client-facing
presentation metadata and is never projected as payload authority or execution
evidence. Before Worker payload or result authoring, dependency results are
narrowed to their existing result fields and optional `semanticCheckpoints`;
work receipts and derived lineage do not cross either raw authoring boundary.
There is no second payload or adapter pipeline for
`execution-agent-v1`.

When direct capability controls refinement exhausts structured-output
validation, the kernel commits the canonical
`reconsider_capability_selection` RoleCall transition. It records the exact
selection and fingerprint, advances the same root activation, and executes no
adapter. Its bounded mechanical cause contains validation metadata but never
raw model output and is projected only to the immediately following Execution
Agent activation. This projection is passive continuity only; it neither
judges the selected capability, chooses a replacement, suppresses a later
model selection, nor establishes evidence.

The role-call ledger separately supervises pre-execution reconsideration. Its
stable identity is derived from steering version, single/batch shape,
capability IDs, canonical selection controls, and the effective working
directory; presentation intent, cause wording, and catalog scope are excluded.
The first matching selection is tracked, the second carries a passive warning,
the third carries a passive intervention notice, and the fourth is atomically
rejected. A separate total budget warns at six, intervenes at seven, and
rejects at eight so changing or alternating selections cannot evade the bound.
Only the immediately following Execution Agent decision sees warning metadata;
capability refinement and response composition do not. New steering or an
accepted mechanical progress transition resets this pre-execution epoch and
hands materialized attempts to operation supervision. A terminal selection
limit executes no adapter and is committed through canonical degraded
finalization rather than surfacing a raw activation-budget failure.
The independent activation budget is not enlarged: if a smaller legal policy
preempts these local thresholds during reconsideration, that exact root path
also finalizes degraded, while activation-limit failures for other actions
retain their existing error semantics.

Events are projections of committed state, never another state store.

## Layout and Ownership

- `request/`: external request execution, dependency composition, the shared
  root kernel, policy contract composition, result contracts, and client plan
  events.
- `orchestration/role-calls/`: canonical call tree, typed transactions,
  internal command decoding/dispatch/state invariants, child return, and
  correlated diagnostics. `reducer.ts` remains the only public reducer facade.
- `orchestration/role-executors/`: mechanical registration and invocation of
  subordinate role contracts.
- `orchestration/worker-capabilities/`: capability binding, controls,
  execution, payload authoring, and settled-result projection.
- `steps/supervisor-decision/`: root semantic decision contract.
- `steps/supervisor-response/`: terminal user-response generation.
- `steps/execution-agent/`: the opt-in Execution Agent decision, capability
  continuation, and raw presentation contracts.
- `steps/planner-graph/` and `steps/auditor-decision/`: policy-specific bounded
  advisory contracts for `execution-agent-v1`; they reuse the same subordinate
  call ledger and settle only passive results.
- `steps/planner-decision/`, `steps/worker-decision/`, and
  `steps/reviewer-decision/`: independent generic role contracts.
- `steps/degraded-finalization/`: bounded failure framing.
- `capabilities/`: generic capability-registry construction and request binding.
- `model/` and `context/`: model invocation, structured/raw boundaries,
  context budgets, attachments, history, skills, and workspace projection.
- `session/`, `events/`, `streaming/`, and `lifecycle/`: persistence, client
  callbacks, status projection, and request completion.
- `adapters/`: replaceable implementations of runtime ports.
- `plugins/`: generic manifest discovery, validation, and catalog projection;
  concrete packages live only under root `plugins/`.
- `config/runner/`: strict request-runner step mappings, timeouts, and context
  budgets.

Files at the root of `src/runtime/` are public facades and composition
entrypoints. Internal behavior belongs beside its owning component.

Long model-visible instruction and repair prose belongs in an owner-local
`prompt.ts`, `*-prompt.ts`, or `*-instructions.ts` module. Input and
orchestration modules assemble canonical data, message roles, and ordering;
they do not embed that prose or import a global prompt dictionary. Protocol
kinds, schema descriptions, validation messages, and evidence framing remain
with the contracts that define them.

## Runtime Config

`loadRuntimeConfig(...)` loads built-in defaults, then
`runtime.config.json` (or `LLM_RUNTIME_CONFIG_FILE`), then supported environment
overrides. The root config points to one request-runner config:

```json
{
  "requestRunner": {
    "configRef": "./request-runner.config.json"
  }
}
```

The referenced file owns model-step routing overrides, request context budgets,
and timeout defaults and overrides. Fresh configurations use schema version 2:

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

Both maps are sparse external configuration. A missing
`models.defaults.steps` entry resolves to the same id as the model step; only
the four canonical non-identity overrides shown above need declarations. A
missing root `steps` entry uses `stepDefaults.timeoutMs` and no additional
instructions. Explicit timeout or `instructionRefs` values override only the
named step.

A file with no `schemaVersion` is legacy v1 and remains supported. The loader
normalizes either external format to the same exhaustive, frozen internal
request-runner policy without rewriting the source file. `schemaVersion: 2` is
the only explicit supported version; any other explicit value fails before use
or write. Fresh init creates v2, while init without `--force` and ordinary
package upgrades preserve an existing v1 or v2 file unchanged.

Every materialized model profile declares its physical context capacity with
top-level `contextWindowTokens`. The selected profile supplies that capacity to
runtime admission and provider projection; the request-runner does not repeat
or override it.

`outputReserveTokens` is minimum input headroom owned by runtime context
projection. It is subtracted while admitting messages so the prompt cannot
consume the whole physical context window; it is never projected to a provider
as an output-token cap. Model-step calibration may tune projection policy, but
it cannot change physical capacity and does not impose a shared per-step
output-token limit.

Current-session conversation continuity is core-owned. The raw transcript stays
canonical, while root decision and response steps receive one passive session
checkpoint plus every uncovered complete turn. At the shared 70 percent
context threshold, the runtime summarizes only the old settled prefix and
keeps the latest ten complete user-agent turns raw. The checkpoint is persisted
with exact message fingerprints and an optimistic source revision; it is not
projected to Planner, Worker, Reviewer, Auditor, payload authors, or tools.
Profiles cannot cap conversation messages independently. Client lifecycle uses
the existing `context.compaction.*` events, with `session_history` retained as
diagnostic scope metadata.

Every tool and skill binding is declared once by a package under root
`plugins/`. Runtime config only applies `plugins.enabled`, `plugins.allow`, and
`plugins.deny`. The request-scoped capability provider projects the effective
registered operations generically for an authorized Worker or root. Adding,
removing, or renaming a tool must not require a request-runner or role prompt
branch.

Environment profiles under `environment.profiles` isolate generated runtime
data roots. Model profiles under `models.profiles` select providers,
calibration, and optionally one registered `execution.policy`. Omission uses
`supervisor-worker-v1`, the behavior-compatible Supervisor root with optional
Planner, Worker, and Reviewer calls. The policy selects model-facing contracts
and mechanical authority only; it is not a configurable workflow graph and
does not decide the next semantic action for the model.

Model context calibration is provider-neutral.
`context.formatTokenAccounting.mode` is `estimate` by default and reserves the
estimated structured-response schema cost. `none` disables that charge for a
transport that does not inject the schema. An optional non-negative
`fixedOverheadTokens` adds transport-specific format overhead in `estimate`
mode only when a structured format is present. Calibration context fields may
adjust projection and token estimation, but never the profile's top-level
`contextWindowTokens`.

A configured profile may explicitly select `execution-agent-v1`; profiles that
omit the field retain `supervisor-worker-v1`. Policy selection is frozen before
the first root activation and never changes because of prompt text, tool
results, calibration, steering, or failure.

## Model Steps

The shared request kernel registers this union of policy and utility steps:

- `supervisor.decision`
- `supervisor.response`
- `planner.decision`
- `planner.graph`
- `worker.decision`
- `worker.result`
- `capability.controls`
- `reviewer.decision`
- `degraded.finalization`
- `execution.decision`
- `execution.response`
- `auditor.decision`
- `context.compact`
- `tool_payload.raw`

Every invoked step receives model policy and timeout configuration after the
versioned file is normalized. External v2 files need not repeat identity
mappings or the default timeout. A model profile calibration slot may override
`timeoutMs` for that model and semantic step when provider latency requires it.
Call sites use the shared model-step registry rather than inferring behavior
from step-name prefixes.

`planner.decision` is the delegated Planner contract and retains its existing
methodology and child-role behavior. `planner.graph` is the separate
Execution-Agent advisory contract: it receives only its bounded objective and
returns a passive proposal or decline. It does not replace, extend, or mutate
`planner.decision`.

## Client and Persistence Contracts

Existing request, session, tool, and event contracts remain stable.

Bridge registration advertises `request_steering_v1`. A compatible bridge may
then deliver `steer_request` for an active `requestId` and receives a correlated
`steer_ack`. The feature is absent until the runtime supporting it reconnects,
so older clients and bridge deployments retain their prior queue behavior.

Top-level delegated Planner calls that commit canonical plan state are
projected as the existing `planner.plan.*` snapshot and item events. Their
payload continues to use `stage=development_plan` for client compatibility.
That stage is presentation metadata only: events are emitted after role-call
commits and never select a role or advance canonical state. `planner.graph`
advisories do not create canonical plan state or these events.

Tool execution continues to use the existing `tool.*` lifecycle. A successful
tool event establishes only that bounded capability outcome, not completion of
the user request.

`execution-agent-v1` alone opts into exact terminal text mode. The shared
finalizer preserves its committed terminal string, including raw non-empty
`execution.response` output, through persistence and delivery.
Omitted/default `supervisor-worker-v1` keeps the legacy normalized
terminal-text behavior.

## Public Package Boundary

Stable public subpath exports are:

- `@abot-ai/runtime/runtime`
- `@abot-ai/runtime/runtime/config`
- `@abot-ai/runtime/runtime/composition`
- `@abot-ai/runtime/runtime/default-adapters`
- `@abot-ai/runtime/runtime/adapters`
- `@abot-ai/runtime/runtime/ports`
- `@abot-ai/runtime/plugin-sdk`

Package consumers should use public ports and composition helpers rather than
request, orchestration, role-step, model, context, or event internals.

## File Size Guardrail

Use a soft 250-300 line budget for hand-written runtime modules. Before a file
grows beyond it, check whether it contains several ownership boundaries that
should be separated locally. Schema-heavy, test, and generated artifacts may
exceed the budget when splitting would reduce clarity.
