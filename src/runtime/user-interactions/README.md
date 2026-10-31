# User interactions

Request-owned presentation shared by root execution contracts. The current
producer is Execution Agent; the implemented interaction kind is `message`.

## Ownership

- A root adapter chooses its model-facing schema, prompts and authoring stages.
  It returns an optional normalized proposal beside the accepted decision and
  declares supported kinds. The shared kernel does not branch on policy IDs.
- `root-publication.ts` checks support, continuing-action eligibility,
  cancellation and steering freshness after decision validation and controls
  refinement, before dispatching the accepted action.
- `request-service.ts` owns publication receipts, Runtime-generated identity and
  ordering. The service is request presentation, not a tool, role-call ledger,
  work-progress store or completion signal.
- Existing event transport owns persistence and delivery. A receipt means accepted
  for publication, not proof of browser delivery or that a user read the message.
- Web UI restores versioned envelopes from request events, including completed
  requests. Its render-only projection interleaves progress and tool activity in
  one chronological timeline above the final answer, without per-update author,
  timestamp or Copy actions. The timeline stays open until a completed answer,
  then collapses with an explicit Show timeline control. SPARK keeps its compact
  progress presentation. Canonical events, message identities and final-answer
  text remain separate.

## Message contract

A proposal contains `kind: "message"` and non-empty text of at most 1,200
characters. Its author may omit it. Updates are encouraged when they add useful
orientation, a material finding or a next step; there is no update quota.
SPARK Chat uses the same EA path with stronger opt-in encouragement for brief,
friendly progress messages. This style policy is separate from shared delivery
and does not change SUPER or require an update before every action.
The complete validated message is published once at a decision boundary.
There is no concurrent model invocation while a tool or child role is running.

EA does not author a separate acknowledgement or per-tool `intent` status.
Optional interactions own its user-facing progress prose. Tool identity,
lifecycle status, controls and approval details remain available independently.
SUPER retains its existing acknowledgement and Worker intent contracts. Its
acknowledgement uses the existing `thinking.delta` transport with explicit
`presentationKind: "acknowledgement"` metadata. The Web UI places only that
marked prose and recorded tool intent in the work timeline; unmarked reasoning
stays separate. Marked acknowledgement events are retained individually during
event-snapshot coalescing. This does not alter model-context compaction.

The `user.interaction` event contains `interaction` with version 1, request ID,
Runtime-generated interaction ID, request-local sequence, publication timestamp,
kind, typed payload and exact originating call/activation/steering identities.
It never emits a terminal event, changes final-answer bytes, or grants permissions.
It is not reasoning or a source of execution evidence.

## Context and continuation

The full messages remain request events. The last eight receipts are retained
in the request presentation snapshot. EA decision and response inputs alone may
project this passive tail, with explicit count and omission semantics. It is
not active user intent and does not reach controls, payload authors, child roles
or SUPER. Empty state adds no context.

Approval parking already captures presentation; resume and its read-only
preflight validate these optional receipts before resumed effects. Older snapshots
without the field restore as empty. No session-message pairing, settled-memory
fingerprints, canonical tool evidence or compaction source bytes are rewritten.
The service is the sole owner; callers do not maintain parallel receipt lists.

Shared capability records may omit presentation intent. Existing saved intent
is preserved through approval restore and selection fingerprints, including
older EA requests. Its absence does not change action identity or permissions.

Updates remain visible in conversation history but are not included in model
history for a later request. They are excluded from answer/stop-acknowledgement
accumulation and ordinary assistant transcript persistence.

## Extension boundaries

A future root contract can opt into supported kinds and normalize its own model
output without reimplementing transport, receipt storage or UI hydration. Its
model stages and role authority still need explicit tests.

A future question kind requires its own schema, correlated answer acceptance,
and an explicit continue-versus-wait lifecycle. No question variants, default
answers, waiting states or generic approval behavior are implemented here.
Existing tool approvals retain their execution authority and failure semantics.
