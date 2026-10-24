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
   `supervisor-worker-v1` exposes the Supervisor contract;
   `execution-agent-v1` exposes the Execution Agent contract and root-owned
   capability actions.
   After presentation and Skills preparation, a new Supervisor request first
   classifies whether a procedure is required, using the current request,
   short system policy and optional bounded passive memory as readable text.
   Configured routing methodology is excluded from this gate and its budget.
   Direct replies proceed to response authoring with the existing full memory.
   Procedural requests separately choose Worker/Planner and a bounded objective,
   or an eligible initial root memory lookup, without a tool catalog or Worker
   capability-group selection. This phase sees
   one exact preceding settled conversation turn (including an assistant
   initiative) and existing bounded memory/time/path
   references; execution owners retain captured Skill guidance and source data.
   An initial lookup always returns to the compact gate with readable, complete
   facts from its current receipt within the existing memory limit. Canonical
   recall records allow only one initial lookup per steering version, subject
   to the request-wide recall limit, even if its result is empty or unavailable.
   Both decisions bind to the current steering version. Once a child has been
   invoked, returned work and further memory recalls retain the existing
   evidence-aware routing, including completion and Reviewer decisions.
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
   When long-term memory is enabled, either root contract may instead select
   `recall_memory`. The kernel invokes the Runtime memory service directly,
   commits a root-bound passive receipt, and resumes the same root under the
   existing activation ceiling. Recall neither creates a child nor consumes a
   capability execution. The bounded projection belongs only to the current
   root steering version and is reused during terminal response authoring.
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

On user cancellation, the request closes its tool resources and drains accepted
steering before persisting an assistant acknowledgement with any already streamed
answer text. This ordinary user/assistant pair enters existing session history
and compaction for either root policy. No model is called to write the stop
acknowledgement. The terminal event remains `failed` / `request_cancelled`, emitted
after persistence, and carries the saved response for consistent live display.
A persistence failure preserves cancellation and sets
`details.stoppedResponsePersistenceFailed`; it does not claim that history was
saved. Earlier cancelled requests without an assistant message are not migrated.

## Knowledge Skill documents

The core-owned `abot_skills` tool provides `list_skills` metadata,
`read_skill` and `read_skills` independently of installed plugins. Multiple reads
accept exact IDs or full case-sensitive names. IDs take precedence; a name shared
by several Skills returns all matches. Reads return at most eight distinct documents
and fail as a whole for an unknown reference or an exceeded limit. A single read
returns one document, or a skills array when its name matches several. It uses the
same Tool Registry, capability execution, permissions, tool events and result
context as other tools. LIST/READ load internal guidance without per-action user
approval in EA and SUPER, including ASK mode; explicit model-level Skills blocks
still apply. The core-only read policy does not exempt other tools or Skill
CREATE/UPDATE. An older request already waiting for approval retains its recorded
approval through resume. Available Skills projects bounded metadata from the same
Store; document bodies enter context only after an explicit read.

The packaged read-only catalog contains ABot Studio, Computer Use, Skill Creator,
Technical Work and What Can I Do? The latter explains supported uses while
distinguishing them from the tools actually enabled for a request. The documents
are packaged source content, not tool action-Skills or system instructions.
They supply procedural reference under the current objective without granting
capabilities, permissions or completion authority. Tool catalogs and selected
operation guidance continue to own tool choice and execution contracts.

EA invokes the tool directly through ordinary tool evidence and compaction.
SUPER selects and reads relevant Skills in its existing discovery step against
the same Store, without a Worker call. Each lookup records its result in the existing role ledger
and uses the existing activation budget. Captured documents are passive context
for SUPER and its Planner/Worker calls, including Worker payload authoring; they
are not copied into objectives or system messages. The existing compactor and
checkpoint restore validate these references against their captured ledger source.
No separate cache, active-Skill registry or resume/compaction mechanism is added.
SUPER reads initial guidance directly; Workers retain LIST/READ and captured
Skill guidance, but cannot CREATE/UPDATE. The same write-ownership filter applies
to the Worker catalogs shown to Planner and Supervisor.
Unknown references fail explicitly. EA and Worker Skill operations use ordinary
`tool.*` events; SUPER lookups use its existing runtime status events. Successful
reads show canonical Skill names without document bodies.
Personal `create_skill` and `update_skill` operations use ordinary mutating
permissions and the existing RAW payload authoring channel, only on user request.
In SUPER, routing selects a separate authoring step only for a requested save.
That step selects metadata; core loads an exact personal edit target and revision,
and RAW writes the complete Markdown from the supplied sources. The full edit
target remains verbatim through compaction. Existing approval/resume executes the
prepared body and controls without reauthoring or refreshing a stale revision.
A settled write or no-save outcome goes directly to the final response; it does
not return to discovery or delegate more work. EA keeps its existing write flow.
Success events show the saved name and ID without the document body.
Personal documents live in `paths.runtimeDir/skills/personal.json`, shared across
sessions/models in that environment; dev/prod separation follows the configured
runtime directories. Writes reuse the existing file lock and atomic replacement.
Updates require the revision returned by READ, so stale edits cannot overwrite a
newer document. System documents cannot be changed through these operations.
An unreadable personal store omits optional discovery and produces an explicit
tool failure; system reads remain available. Research Skills remain outside this stage.

The Web UI manages personal Skills through the environment owner's
`personalSkills` service and the existing local RPC. It creates personal documents
with generated IDs, lists metadata, loads a selected document, edits content only,
and archives/restores by expected revision.
System documents are excluded and immutable; archived documents are view-only
until restored. Archive state shares the same file and lock as model writes.
New model LIST/READ calls exclude archived records, including reads by name; model
updates cannot revive them. Previously captured tool/role evidence stays intact.
The store reads schema v1 records as active without rewriting on read; the next
mutation writes schema v2 with explicit archive state. Older runtimes reject v2
rather than silently dropping archive state. No hard delete/import/sync UI or
dedicated authoring model is added.

Core tool names and operation contracts share `capabilities/core-tool-contracts.ts`.
Runtime loading silently ignores an entire plugin that declares a reserved tool
name or operation ID, before loading its entrypoint or action-Skills. Reserved
operation IDs are derived from the same contracts used by native definitions.
The installed package and saved plugin selection remain unchanged.

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
  owns capability and control selection. Worker and Planner result prose has no
  fixed character ceiling; model context admission and compaction retain their
  configured budgets. Result validation still requires non-empty text and exact
  caller, dependency, and receipt bindings.
- **Planner Graph advisory contract** may propose or decline one bounded
  dependency graph for the Execution Agent, including sequential steps or
  parallel components converging into one integrated deliverable. It is a
  terminal passive child result: it cannot execute graph nodes, adopt a plan,
  or commit completion. The root model may explicitly adopt its exact proposal
  and report item progress alongside an existing decision.
- **Worker** performs one bounded objective. It may return a substantive result
  from supplied knowledge or invoke one offered capability when an external
  observation or effect is required. Its structured decision selects the
  action; substantive completion text is authored separately as raw text.
- **Reviewer** independently assesses bounded supplied work in the delegated
  policy and returns a human-readable summary plus a bounded, revision-bound
  `reviewer_verdict_v1` receipt to its exact caller. The receipt is passive
  canonical evidence; it does not choose remediation or finalization.
- **Auditor** receives typed criteria and a complete canonical work inventory
  in the direct policy. It independently selects evidence by execution ID,
  then returns a passive pass/gaps/needs_evidence advisory. A request for more
  evidence identifies the complete next bundle; the next root invocation of
  the same criteria binds those exact records without rerunning tools. Pass
  requires full inventory classification and sufficient facts from all needed
  entries in the current bundle. Previews and prior advisory summaries are not
  proof. A verified existing EA source digest replaces the corresponding raw
  adapter result, using the same source identity check as payload authoring;
  new or uncompacted results retain their original representation. The audit
  retains its own criteria and receives no EA continuation or decisions.
  Summary omissions do not prove absence: missing material detail returns as
  `gaps` for the EA to collect focused fresh evidence. `needs_evidence` selects
  other existing representations, not hidden originals behind summaries.
  Selected representations are never compacted again or truncated to fit. The
  configured model context budget controls admission, with no separate fixed evidence-count or
  character ceiling. Exact duplicate receipt supplements use explicit paths
  into the same unchanged original adapter result. Capacity failures return a
  failed advisory instead of requesting repair of a valid evidence selection;
  the root still owns the next action.

Finished audits and already reviewed bundles are unavailable for unchanged
work and steering. Canonical work results or new user steering can reopen an
audit; plan progress, capability-scope changes and advisory returns alone
cannot. These mechanics prevent repeated identical reviews without choosing
evidence relevance or semantic completion for the models.
The Execution Agent's policy favors completion review after implementation and
available validation, with another review after addressing findings. An earlier
targeted review remains available for user requests or decisions that benefit
from it; the runtime never schedules reviews from tool settlement.

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

`orchestration/role-calls/` ledger v18 is the sole writer of the request-local call tree
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
capsule; a direct root payload carries its selected bounded `operationObjective`
through the same `authoringObjective` channel, bound to the exact request source,
ordered steering and immutable controls. Fully selected controls need no extra
model round. Controls-only objectives do not enter payload authoring.
Capability `intent` is bounded client-facing
presentation metadata and is never projected as payload authority or execution
evidence. Before Worker payload or result authoring, dependency results are
narrowed to their existing result fields and optional `semanticCheckpoints`;
work receipts and derived lineage do not cross either raw authoring boundary.
There is no second payload or adapter pipeline for
`execution-agent-v1`.

For `execution-agent-v1`, the frozen request policy disables automatic loading
of related files from prior artifact references before both ordinary and staged
payload authoring. The Execution Agent gathers required source evidence through
observation capabilities; those settled results keep their existing downstream
projection and compaction rules. An explicitly selected edit target retains its
own target-context loading. Supervisor/Worker artifact loading is unchanged.

For ordinary observation capabilities without payload authoring, the Execution
Agent selects the complete operation controls in its decision, including optional
ranges and locators. Only guidance for offered observation capabilities is included
in that decision. Accepted controls are validated and passed directly to execution;
optional null values mean omission and retain the tool's defaults. Mutation, mixed
and payload-authored operations retain staged Controls, and the shared descriptors
and Supervisor/Worker partition remain unchanged. Observation guidance and the
expanded decision schema participate in the existing context budget.

When an Execution Agent operation has remaining controls, its decision selects
`controlsEvidenceExecutionIds` from the settled executions of that same root
call. The decision state exposes eligible IDs even after root compaction. An
empty selection supplies no prior tool-result bodies to Controls. Selected
results use the canonical evidence projection once per batch; each slot retains
its own evidence bindings and bounded operation objective. Results already
covered by the same EA call's verified checkpoint use their source digests;
fresh or uncovered results retain their original representation. Reuse uses
the shared source identity check and transfers neither the EA continuation nor
unselected sources. The canonical ledger and selected-result binding stay exact;
only the model-visible bodies change. Controls compaction
is bound to that frozen assignment and steering version. The selection field
ends at refinement and never enters adapter controls or prepared approvals.
The delegated Supervisor workflow retains its shared Worker evidence scope and
staged decision, Controls, payload, result and review contracts.

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
checkpoint plus every uncovered settled turn. A standalone assistant initiative
is a settled turn with no user message; it stays in ordinary chronological history
and follows the same retention policy. At the shared 70 percent context threshold,
the runtime summarizes only the old settled prefix and keeps the latest ten turns
raw. The checkpoint is persisted with exact message fingerprints and an optimistic
source revision; it is not
projected to Planner, Worker, Reviewer, Auditor, payload authors, or tools.
Profiles cannot cap conversation messages independently. Client lifecycle uses
the existing `context.compaction.*` events, with `session_history` retained as
diagnostic scope metadata.

Active-request semantic checkpoints retain their separate source scope. The
compactor receives invocation-local source keys, and each returned digest is
bound to that key before the runtime stores the existing v2 checkpoint. Every
checkpoint projection identifies its contents as passive evidence from the
listed sources; an omitted fact does not establish absence or change the active
assignment, tool authority, approval state, or completion status.

Checkpoints bound exclusively to Execution Agent decision/response consumers
use preservation guidance for unfinished implementation and transformations,
including concrete identifiers, interfaces and their associations. Other consumer
bindings retain their existing instructions. This changes new summary generation
only: source fingerprints, checkpoint schemas, restore and budget policy stay
unchanged, and previously saved summaries are not regenerated.

The complete active-request checkpoint (source digests, continuation, and its
reference envelope) has a shared token budget of 30 percent of the consuming
model's configured context window. Generation validates the projected checkpoint
using provider input counting when available, otherwise the configured estimator.
There is no aggregate 8,000-character quota. Structural identity and per-field
continuation constraints remain enforced; full-message admission separately
accounts for instructions, other retained input, and response headroom. Oversized
checkpoint output uses the existing repair path with measured usage and allowance.

Immediate operation-supervision evidence is bound to the current request, call,
activation and ledger revision. After checkpoint projection, EA decision/response
and SUPER Worker decision/result inputs retain an exact action/result reference
when that lane remains present. If the same owner's verified checkpoint covers
the canonical result, the notice keeps its accepted action and outcome receipt
and refers to that checkpoint's partial source digest instead of restoring the
raw result. Covered receipts replace summaries that exactly repeat registered
tool output with a compacted-source notice; independent summaries stay unchanged.
This also applies to the Worker's covered-results list. Canonical source bytes
and checkpoint fingerprints remain intact. The binding uses registered source
bytes and fingerprints, never model-authored envelope labels. Uncovered and cross-call evidence keeps its
canonical original. The final input, including this evidence, passes ordinary
context admission before a new checkpoint is committed. Controls and payload
authors do not receive this current supervision capsule.

Every tool and skill binding is declared once by a package under root
`plugins/`. Runtime config applies `plugins.enabled`, `plugins.allow`,
`plugins.deny`, and the exact-ID `plugins.disabledPluginIds` block list.
Exact disabled plugin IDs do not match capability names or qualified selectors. The request-scoped capability provider projects the effective
registered operations generically for an authorized Worker or root. Adding,
removing, or renaming a tool must not require a request-runner or role prompt
branch.


A model profile may further narrow this catalog through `plugins.deny`.
The request captures these selectors from its effective primary profile in the
existing execution selection, including the saved approval continuation.
The shared request Tool Registry applies them alongside permission-mode
restrictions to discovery and execution for both root policies. Per-step model
overrides cannot change the captured restriction; other requests retain their
own profile selection. The metadata is not projected to the model gateway.

ABot Studio draft authoring uses the same capability engine. The
`automation_builder` capability creates a draft from optional `settings` and
ordered `steps`. Each step has a local `key`; explicit `$key` result bindings
connect steps, and parallel steps contain arrays of branch steps. A focused
compiler generates the canonical mutation envelopes, parent references and
positions, with the same defaults as individual edits. Updating an existing
draft still uses the canonical mutation batch and expected revision; legacy
batch creation remains supported. Both routes commit in one transaction.
The draft manager owns generated node IDs,
local-reference resolution, graph validation, revision checks, and the single
commit. A rejected group persists none of its changes. The model-facing
authoring surface offers connected writes, discovery, reads,
validation and saved-agent reuse. Granular editing actions remain supported by
the direct adapter API but are not offered as competing model capabilities. Neither
authoring capability can grant permission, publish, activate, or run a draft,
and neither is selectable as a step within an automation.

Model-facing `browse_catalog` reads the compact global index without requiring
a draft. `prepare_draft` resolves a bounded set of exact operation references
from that canonical catalog and returns their schemas plus the complete
authoring reference. That passive reference includes structured agent results,
bindings, settings and their limits; it grants no authority to execute future
steps. Discovery controls are selected completely so no extra controls-model
round is required. Legacy direct catalog and granular-edit contracts remain
available for compatibility.
The builder declares one structured payload stage through the existing generic
tool metadata. Its bounded generation schema reaches both root and Worker
payload models and is projected by each provider adapter. Canonical parsers
still enforce field limits, references and graph semantics before persistence;
the generation format neither repairs invalid output nor retries it.
Authoring changes do not alter context-window capacity, compaction, role
authority, or the shared request loop.

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
methodology and child-role behavior. Supervisor and delegated Planner model
outputs normalize repeated Worker catalog group IDs to their first occurrence
before strict scope validation. This preserves the selected set and order;
unknown groups, invalid values and extra scope fields still fail validation.
The canonical role-call scope remains strict, and no prompt instruction,
repair attempt or model call is added. `planner.graph` is the separate
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
commits and never select a role or advance canonical state. A `planner.graph`
advisory alone creates no plan or event. The Execution Agent can attach an
explicit plan adoption or progress report to an existing decision. The ledger
binds its exact source and item identities on the root, and the same observer
projects those committed reports into the existing events. This adds no model
turns. The statuses are model reports, not tool evidence or completion gates;
Planner/Auditor returns and tool settlement never auto-complete their items.
The delegated policy keeps its existing Worker-bound plan semantics.

Direct child openings under the Supervisor root contract also project
`role.delegated` after the canonical commit. A request-owned observer reads the
committed caller, child identity, recipient role and objective; it never changes
model context, selects a role, or makes a model call. The event is a historical
delegation receipt with no runtime stage or phase. Execution Agent and nested
Planner delegations are excluded. Existing event persistence supports live and
replayed display; approval continuation restores the child without reopening it
or re-emitting its delegation. Existing commit-observer failure semantics apply.

A matching `role.returned` receipt projects a direct Planner's committed
result back to its Supervisor caller. It reads the canonical result identity,
outcome and complete summary after `child_returned`; failed results remain role
outcomes, not request-terminal events. Existing event persistence supports
live and restored Planner-card content, with independent return deduplication.
Checkpoint restoration does not re-emit prior results. This observer adds no
model context or calls and retains the existing observer failure boundary.

Tool execution continues to use the existing `tool.*` lifecycle. A successful
tool event establishes only that bounded capability outcome, not completion of
the user request.

`execution-agent-v1` alone opts into exact terminal text mode. The shared
finalizer preserves its committed terminal string, including raw non-empty
`execution.response` output, through persistence and delivery.
Omitted/default `supervisor-worker-v1` keeps the legacy normalized
terminal-text behavior.

## Public Package Boundary

### Scheduler lifecycle

For installed clients, use `createLocalRuntimeApplication(config)` from
`@abot-ai/runtime/runtime`. It automatically attaches to or creates one local
environment owner. Web and Bridge use the same managed facade, so requests,
session deletion and scheduling share admission across processes. Start with
`await application.start()` and close with `await application.stop()`; closing
an attached client leaves the owner running. See
[local ownership and client lifecycle](local-host/README.md).

`createRuntimeApplication` composes one local scheduler and its management
capability. Call `await application.start()` to load persisted Jobs and begin
the clock, and `await application.stop()` when shutting down. The local Web
backend starts all configured environments without waiting for a browser visit.
Scheduling can also start lazily when its built-in capability is first invoked.
After shutdown, explicit application or compatibility-host startup can restart
the same scheduler. Lazy management cannot revive a stopped scheduler. New
subscribers belong to the restarted lifecycle; old run events cannot cross into
it, and interrupted work is never retried.

The compatibility `createDefaultRuntimeDependencies(config).host.start()` and
standalone default host also start their composed scheduler automatically. The
synchronous handle exposes optional `ready` for asynchronous startup and `stop`
for both scheduler and Bridge; host requests and optional steering await
readiness and reject after shutdown. Host adapter overrides that change execution
or storage rebuild the scheduling graph. An event-only override rebinds future
scheduled requests while preserving the existing scheduler, admission, session
guard and subscriptions; running requests keep their captured sink. Starting the
default host again restores its sink for future schedules. The default-adapters
facade delegates these
responsibilities to `runtime-environment`, `runtime-host-environment` and
`runtime-host-lifecycle`; caller-supplied stores and registries remain injected.

`application.services.scheduler` provides create/list/get/update/pause/resume/
cancel/runNow and run history. Model calls bind the current conversation and
model mechanically; the Web page selects an existing conversation and model.
Each scheduled run enters the ordinary request handler with FULL permissions,
its saved model, current canonical history, and one persisted trigger message.
The trigger's immutable `schedule` reference identifies the Job and Run; its
message content is the exact historical prompt. Provenance comes from an internal
scheduler option bound to the exact request and session, never from public
`run_request` fields. Supplied `schedule` fields do not mark ordinary requests as
scheduled. Scheduled events can be observed
through `application.subscribeScheduledEvents`. Consumers may supply
`scheduledRequestOptions` for the existing approval and steering controllers.
Scheduled terminal events are published once after the handler settles. Success
requires the correlated assistant reply in canonical session storage; missing or
failed persistence is published as failure instead of an earlier completion.

Session admission defers scheduled work while ordinary requests are active;
subsequent ordinary requests wait for a running scheduled reservation. Existing
ordinary-request concurrency is unchanged when no scheduled reservation exists.
The composed SessionStore facade serializes mutations and marks deletion intent
synchronously. It uses the injected backing store but intentionally does not
preserve that object's identity: all callers must use the composed facade for
deletion and request persistence to share the lifetime guard.

Session deletion keeps its tombstone even if backing deletion or cleanup fails.
A later explicit delete retries only failed listeners from the original deletion;
successful cleanup is not repeated and newly registered listeners are not
retroactive. Concurrent deletes share the cleanup attempt until all listeners
settle. Successful physical deletion retains its original result until cleanup
succeeds, so an explicit retry can finish consumer attachment cleanup. Both
delete APIs use the backing store's statistics operation; the boolean API projects
its `deleted` result. The receipt is delivered once, including across API variants.
Cleanup never revives the session or reruns scheduled work.

See [scheduler ownership and time rules](scheduler/README.md) for persistence,
offline behavior, cancellation, and local ownership locking. Stopping does not
drain active model requests or retry interrupted work. This lifecycle does not
start a separate model loop or alter the Supervisor/Worker/Execution Agent roles.

The conversation-scoped `schedules.list` tool returns at most 100 Jobs per page,
newest first, without their stored prompts. Pass `nextCursor` as `cursor` to
continue until it is null; `omittedCount` describes the entries after that page.
A stale cursor fails explicitly and requires listing from the beginning. This
passive listing never schedules or executes work; `get` resolves an exact Job ID.
`get` requests the latest 20 runs from storage before loading their payloads and
returns that bounded history in chronological order, without pruning older runs.

Creation is projected as six flat operations (`create_timer`, `create_once`,
`create_interval`, `create_daily`, `create_weekly`, `create_monthly`). Each fixes
the adapter's `action=create` and schedule kind mechanically and requires only
its relevant timing fields. Calendar variants require an explicit IANA time zone.
Missing required timing is rejected before dispatch; model and conversation
binding remain owned by the active request. Recurrence changes use six matching
`update_*` operations with complete required timing and fixed action/kind.
The plain `update` operation edits metadata while retaining the recurrence;
omitted time zone, model and mode retain their saved values. The scheduling tool
has 19 operations under the shared 32-operation contract limit. Other management
operations and the underlying scheduler service keep their existing contracts.

`SchedulerService.listRuns` preserves complete chronological results when no
query is supplied. Optional cursor/limit queries return bounded newest-first
records with an exact Job-scoped run cursor. The Web requests one lookahead
record before owner RPC serialization, returns 50 runs by default (maximum 100),
and preserves access to older full records.

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
