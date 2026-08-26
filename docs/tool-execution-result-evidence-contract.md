# Tool Execution Result Evidence Contract

## Status

This document defines the stable product contract for Runtime-owned capability
result evidence. It applies equally to direct-root and delegated execution.

The contract is intentionally generic. No runtime branch may inspect a plugin
id, capability id, operation id, field name, or prompt wording to decide which
tool facts the model receives.

## Goals

1. Every settled capability execution owns one canonical, JSON-safe adapter
   result in the RoleCall ledger.
2. Every registered plugin result is represented by the same complete
   `ToolExecutionResult` envelope, including `output`, `data`, actions, failure
   fields, and execution metadata.
3. The exact producing call can consume that result regardless of whether the
   authorized principal is the direct root or a delegated Worker.
4. Subsequent payload authoring inside the same call can consume the same
   evidence without a plugin-specific bridge.
5. Request-wide receipts, child handoffs, role authority, and completion
   semantics remain unchanged.
6. Invalid, cyclic, non-JSON-safe, or oversized results fail explicitly before
   canonical settlement. Evidence is never silently truncated or partially
   parsed.

## Non-goals

- The Runtime does not decide which tool a model should select.
- The Runtime does not infer semantic completion from a successful tool result.
- The Runtime does not add retries, repeated-call guards, or plugin-specific
  fallback behavior.
- The Runtime does not copy complete child evidence into a Supervisor,
  Planner, Reviewer, sibling Worker, or unrelated request.
- The contract does not require capability-specific projection or plugin
  migrations.

## Public Producer Contract

Plugin handlers return `ToolImplementationOutput`. `ToolRegistry` is the sole
owner that adds the selected tool identity and produces `ToolExecutionResult`:

```text
ToolExecutionResult
  ok: boolean
  tool: non-empty string
  output: string
  producedNewInformation: boolean
  progress?: boolean
  actions?: ToolActionSummary[]
  exitCode?: finite number
  stdout?: string
  stderr?: string
  data?: JSON-safe object
  error?: string
  errorCode?: string
```

The registered-tool adapter wraps this value once as
`registered_tool_execution_result_v1`. Runtime-owned rejections use
`runtime_capability_rejection_v1`. Legacy or injected adapters that do not
provide an envelope are captured mechanically as
`generic_capability_result_v1`; their payload is not semantically rewritten.

All three variants are `CapabilityAdapterResult`. The capability engine must
attach one normalized variant to every settlement.

## Validation And Bounds

The Runtime validates the result before ledger settlement:

- plain enumerable data properties only;
- JSON primitives, objects, and dense arrays only;
- finite numbers only;
- no functions, symbols, accessors, cycles, or non-plain prototypes;
- the registered result must match the public `ToolExecutionResult` fields;
- references remain bounded by the RoleCall reference contract;
- one serialized canonical adapter result is limited to 256 KiB.

The 256 KiB limit is a hard producer boundary, not a model-context truncation
rule. An over-limit result becomes an explicit technical capability failure.
The Runtime never sends a syntactically valid but incomplete object and never
pretends that omitted structured facts were observed.

Plugin results are model-facing evidence and therefore must not contain
secrets. Secret acquisition and redaction remain responsibilities of the
owning tool/host boundary; core orchestration must not guess sensitive field
semantics from arbitrary JSON keys.

## Canonical Lifecycle

```text
plugin handler
  -> ToolRegistry creates ToolExecutionResult
  -> normal invocation returns the complete result
  -> registered adapter creates CapabilityAdapterResult
  -> capability engine validates/captures the result
  -> RoleCall reducer atomically settles outcome + exact result
  -> exact producing consumer receives the result
```

Settlement is atomic. A ledger entry cannot be `settled` without a valid
canonical adapter result. Running entries cannot contain one.

## Model Projection And Authority

The canonical result proves only its own recorded execution and effect. Its
contents are untrusted reference data, never instructions, user intent,
authority, or proof that the whole request is complete.

Projection is deliberately exact-consumer scoped:

- `execution-agent-v1`: the active root keeps the existing provider-native
  assistant-tool-call / linked-tool-result lane. Its message shape and order do
  not change.
- `supervisor-worker-v1`: the Worker that produced the execution receives
  `adapterResult` on its entry in `runtime_request_tool_results_v1` when it
  resumes and when its result author runs.
- Capability payload authoring for that same call receives the canonical
  result in `settledCapabilityResults`.
- Other calls receive the existing bounded receipt (`outcome`, effect,
  `summary`, references, and allowed `referenceData`) and the normal child
  handoff. They do not receive a second copy of the exact body.

This preserves least authority and prevents context presence from being
mistaken for user intent. A Worker may use exact facts to fulfill its immutable
objective, but those facts cannot broaden that objective.

## Compaction

An exact result is a semantic-compaction source for its producing Worker. Until
a checkpoint covers that execution id, the complete result remains in the
Worker evidence block. After a validated checkpoint is committed, the exact
body and legacy `referenceData` may be replaced in model context by the
checkpoint digest plus the immutable execution receipt. The canonical ledger
entry remains unchanged.

Compaction is never a fallback for an invalid or over-limit result and never
changes execution outcome, authority, or persistence.

## Compatibility

- Existing summaries and `referenceData` remain populated and projected.
- Existing tool events and client payloads do not change.
- Direct-root native tool linkage and exact result content remain unchanged.
- Role result, request finalization, artifact continuity, and tool-selection
  contracts remain unchanged.
- Settled RoleCall execution state requires canonical result evidence for every
  authorized principal.
