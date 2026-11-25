# Persistent Agents

The durable product contract is [agents-layer.md](../../../docs/development/agents-layer.md).
The Agents coordinator is **ABot** (`abot`). The existing Spark feature remains independent.

## Execution boundary

Agents owns definitions, conversation context, missions, session associations,
decision traces, invocation accounting, Attempts, peer exchanges and schedules.
It is a client of the existing runtime. `ordinary-session-port.ts` calls the normal
managed request interface, with the Agent's selected model and ordinary permission
mode. The work session uses that same model. Approval, tool execution, request
cancellation, session history and result replay remain the existing runtime's work.
No looper, request runner, tool implementation, gateway wrapper or core compaction
mechanism is changed by this module.

The managed runtime owns the Agent application, receipt observer, schedule lifecycle
and permission checks. The Web UI and the private Socket submit commands to that
owner. Opening a conversation reads its public view. Agent onboarding, prompt
generation and budget recommendations use the configured model profile in the
runtime. The Web UI keeps device drafts, unread notifications and its local diagnostic
view. The owner filters ordinary chat summaries by session ownership before paging
them for the bridge.

## Ownership and responsibility

An Agent owns its work sessions across missions and can open a new session or
continue an exact owned session. One active or waiting mission is admitted per Agent;
other Agents can work concurrently. No session can be adopted through a model-proposed
identifier. The first work request stores its Attempt and session association before
creating the session, then durably claims dispatch before the normal request call.
`requestId` and the immutable request fingerprint identify that exact attempt. A
repeated message or claim cannot start it again.

A responsibility cycle uses separate management model calls. SUPER assesses,
selects a closed action, then authors the accepted assignment or reply. EA combines
assessment and selection, followed by authoring. Strict parsing and deterministic
admission check ownership, source revisions, policy, available budget, permissions
and evidence references. Invalid model JSON is retained as a rejected trace and
waits for a user decision; there is no unbounded repair loop. Final reply and task
completion publish together. A normal session's completion does not itself complete
the Agent's mission.

Completion requires completed, measured session evidence for the current mission,
or an explicitly inspected owned session; failed and cancelled results cannot be
completion evidence. A delegated result must have a typed completed outcome. The
model proposes which accepted criteria are met; code checks the criterion/evidence
bindings. It does not prove the semantic truth of model conclusions.

The current deterministic progress signal is a new normalized source URL in a
completed result. Rewording the same output does not reset the no-progress counter.
A new URL is source-identifier novelty, not proof of new or correct facts. Tasks
without new source identifiers rely on completion assessment within the agreed
attempt/no-progress limits. The source result remains available even when the
controller exhausts its allowance.

## Context, conversation and intervention

The Agent has a private durable conversation and base prompt, independent of its
work sessions. Context projection includes the current accepted request exactly
once, scoped structured state, bounded Agent history and explicitly labelled work
results. Historical conversation, peer responses and session output do not create
new task or permission authority. Full records remain in the store; bounded
projection reports omissions. No new model compactor is introduced.

A user conversation while work runs is a separate management call, serialized with
that Agent's other management calls and charged to the same mission. Conversation
mode cannot dispatch work. If the remaining allowance is reserved by a peer exchange,
a canonical status reply records that limitation without pausing or changing the
task. Explicit pause, cancellation and task guidance use source-side mission
revisions and ordinary request cancellation. Known clarification resumes the same
mission and remaining allowance; it does not reset accounting.

## Shared budgets and peer dialogue

Limits are explicit user choices or previously saved Agent defaults. There are no
hidden production mission budgets. Management allowance is durable before a model
call. Actual usage is charged once; missing usage stays unknown. Ordinary work usage
comes only from existing persisted runtime events. Agent admission limits govern
whether another call or work request may start; they do not replace the normal
runtime's internal execution limits or impose provider hard token caps. Reported
overspend is retained and prevents further autonomous work.

ABot can delegate a bounded assignment to a listed, available Agent within the
original authority and budget. The mailbox stores the assignment and reserves its
allocation before contacting that Agent. Child replies, attempts, model costs and
clarification rounds settle in the original parent budget; unknown receipts never
become zero usage.

A child can ask ABot a clarification tied to its exact question, source assignment
and correlation. While the child is parked, a durable claim lends one remaining
child model call and a finite token allowance to the coordinator reply. The parent
ledger charges the actual reply; unused token allowance returns to the child, whose
remaining limits shrink by the actual cost. The child cannot spend the loan while
it is reserved. ABot's reply sees only the accepted current parent request, explicit
current user clarification and bounded assignment/question, excluding private prior
conversation and standing prompts. A typed answer resumes the same child mission;
`needs_user` waits for explicit user input. Unknown or malformed replies freeze both
participants. Duplicate questions and restarts never replay the reply call. Existing
clarification limits bound this dialogue as well as user questions.

## Bounded work and delegated attention

Work decisions receive canonical remaining rounds, model calls and tokens. A new
work assignment stores its resource snapshot before dispatch; historical requests
are never rewritten. EA and SUPER use their existing policies, with return-planning
estimates of three and six calls respectively. These estimates leave room to gather
findings and reply; they are neither guaranteed cost bounds nor permission changes.

The Agent-owned observer reads ordinary request receipts during work. Near the
return reserve it sends one stable wrap-up instruction through existing request
steering. ASK waits are deferred. If confirmed usage reaches the hard limit, it
requests ordinary cancellation and projects a system outcome with saved-work access,
without inventing an Agent reply. An in-flight provider call can still overshoot;
missing final usage remains unknown.

Delegated approvals are visible in the coordinator conversation and the space, with
navigation to the exact child. Grants remain owned by the ordinary approval endpoint.
Each wait identity can produce its own Web notification even without an Agent revision
change. Public child progress is forwarded through exact mailbox bindings; private
assignments and reasoning stay private. One five-minute model checkpoint is charged
to the working child's shared allowance, not duplicated at the parent.

See [incident, contracts and verification](../../../docs/development/agents/delegated-work-validation-2026-11-19.md).

## Durability and recovery

`FileAgentStateStore` is the canonical writer. Public management uses global CAS;
internal receipts use the same lock and exact source identity/revision validation.
Every load and commit checks record shape, ownership, receipts, result fingerprints
and minimum charged usage. A directory-publication uncertainty latches that instance
until reconciliation. Corrupt or unsupported data fails closed rather than creating
an empty workspace. Windows retains the existing platform-specific durability limits.

Recovery inspects existing requests only. Persisted running status is not proof that
an execution owner is alive. An unresolved request or model/peer usage is owned by
the user. Continuing after an unknown outcome requires explicit acknowledgement and
new finite limits, creating a new mission while retaining the original accounting.
The old request is never replayed. Durable approvals remain parked; the Agent-owned
observer can inspect their eventual existing result and continue an accepted task
without a browser tab. Cancellation follows only exact linked child missions, including
after restart, and never cancels a newer unrelated task on the same child Agent.

State schema 5 reads schemas 1–4 through a pure projection. Legacy coordinator
identity references migrate to `abot`, including peer roles, session ownership,
Attempts and verified request fingerprints. Stable request/session/message/correlation
IDs, revisions, budgets, uncertain outcomes and historical text remain intact. Only
exact former default coordinator presentation changes; custom prompts are preserved.
Known early schema-3 messages and missing peer outcomes are projected conservatively;
missing outcomes remain unknown. Reads preserve original bytes; the next explicit
mutation publishes schema 5. Older binaries reject the newer schema; there is no
silent downgrade or history stripping.

Agent schedules use their own durable file and normal Agent admission, with finite
occurrences, finite per-occurrence limits and exact Agent revision binding. Their
source-side claims prevent duplicate submission; the ordinary runtime scheduler is
unchanged. See the schedule contract and evidence in the linked development documents.

## Verification

Focused tests use scripted models and include the actual ordinary managed runtime
path for EA and SUPER, approval continuation, bidirectional peer dialogue and restart
cancellation. Additional source tests cover multi-session work, later session reuse,
context isolation, budget loans, unknown outcomes, malformed decisions, deterministic
progress, state corruption and identity migration. These checks do not establish
live local-model quality. See [module evidence](../../../docs/development/agents/module-validation-2026-11-17.md)
and [runtime integration evidence](../../../docs/development/agents/runtime-validation-2026-11-17.md).
