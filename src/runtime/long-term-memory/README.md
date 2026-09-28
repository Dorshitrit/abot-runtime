# Long-term memory

This package owns cross-session memory retrieval, reconciliation, persistence,
and management. It is a core Runtime service, not a model-facing capability and
not a dependency on `plugins/memory`.

All automatic learning writes through `maturation`: conversation authoring,
Co-worker reviews, and the compatibility observation adapter. The conversation
and observation adapters only translate inputs; neither owns a separate writer.
Sources retain their distinct provenance and receipts commit atomically with candidates/memories;
replaying a committed batch cannot recreate a record the user deleted. Automatic
chat context projects only observation source kind, time and uncertainty, without
transport identifiers or source history. Existing conversation memory projections
are unchanged.

Observation replay receipts retain the batch's fixed evidence expiry. Writes
remove expired receipts, while rejecting expired batches before embedding and
again at commit, so pruning cannot revive a deleted memory. Earlier receipts
without an explicit deadline remain protected for 24 hours after their commit.
Pausing or resuming a batch does not extend this lifetime.

Automatic memory admission has one core owner: `maturation/`. Conversations
and desktop activity first create bounded candidates; only reinforced, mature
candidates enter Stored memories. The default score is 90 and can be set from
0 to 100; promotion also needs two independent evidence opportunities.
Unchanged revisits, repeated input, future companion timestamps, replayed
batches and scheduled re-evaluation do not supply fresh evidence.
The existing authoring model assesses lasting usefulness; the core enforces
identity and protection without an additional model call. Shared guidance
excludes task diaries, transient status and synthetic QA data from user knowledge.
Automatically proposed changes to an established memory stage a replacement
candidate bound to its exact version. Manual memories and manual edits remain
protected, and explicit manual creation remains direct. Automatic authoring has
no score-based bypass of maturation. A direct request to remember a fact is
classified within the existing terminal authoring result. The model supplies
an exact quote that the core binds to the current user message before the
existing management create/update writes protected memory. This path adds no
model call and does not affect Co-worker's automatic candidate threshold.

The explicit `plugins/memory` tools retain their separate deterministic store and
do not require embeddings or this service. They neither write to Stored memories
nor participate in automatic maturation. Manual changes through the existing
core memory management UI remain protected from automatic learning.

Candidates default to 30 days without reinforcement, at most 500 records or 2 MiB,
whichever is reached first. Provenance is capped at eight sources and three proof
entries. Existing stored memories are not bulk-demoted or deleted by the upgrade.

Core retention starts with the memory service and schedules only the next storage
expiry, including when Co-worker or embeddings are disabled. Commits re-arm that
deadline; an empty store has no maintenance timer. Standalone owners should await
`memory.retention?.stop()` when releasing a service, and may call `start()` to
resume it. Runtime environment and host lifecycles manage this automatically.

The memory repository owns the shared maturation policy, including while
Co-worker is off. Co-worker imports its legacy preferences only if the repository
has no policy, then displays and edits the canonical policy. Its saved policy field
is a non-authoritative compatibility projection, not a second admission mechanism.
Preference saves persist that projection before publishing canonical policy; if
the policy write fails, the previous projection is restored.

Version 5 stores this policy, conversation candidate provenance and independent
reinforcement proofs. Existing versions 1, 3 and 4 remain readable; version 2 is
an unsupported QA prototype. Reading legacy candidates never invents proof from
their capture count. Before the first v5 write, file storage keeps an exact private
`memory.json.pre-v5.backup`. Older runtimes reject v5 rather than bypass its
admission rules; downgrade requires restoring that backup. Reading alone does not
rewrite a repository.

Conversation-authored passive candidates are scheduled on the service-owned background save queue
after the terminal response is persisted. The request lifecycle does not await
embedding or store work; queue failures and deadlines remain memory diagnostics
and cannot change the completed user response.
Direct user-requested saves share this queue, so a response must not claim the
write completed before the service confirms it.

Desktop observation batches originate in the separate `passive-learning` service.
They use this same memory repository and embeddings through shared maturation,
with source metadata and an atomic replay receipt. Collection and
batch model scheduling do not belong to the memory service. Existing conversation
retrieval remains unchanged.

When client events are enabled, scheduling emits `memory.save.queued` before
the terminal response. Background completion and failure remain diagnostic-only
because they occur outside the request lifecycle.

Terminal response authoring receives the automatic passive projection. When
memory is enabled, Supervisor and Execution Agent root decisions may also select
`recall_memory` with a bounded query. The shared root kernel invokes this same
service, records the result in the RoleCall ledger, and resumes the exact root.
No capability catalog, controls, payload author, or child role is involved.

Explicit recall is bound to the root call, activation, and steering version. Its
continuation uses `runtime_memory_recall_reference_v1`, with record identity,
provenance, `found` / `empty` / `unavailable` status, and declared omissions. The
query is at most 1,024 characters; each receipt and the complete projected capsule
are bounded to 6,000 serialized characters and at most six whole records. The
existing per-call activation ceiling is reserved before retrieval. Recall does
not reset capability-selection supervision or write completion evidence.

`longTermMemory.maxRecallCallsPerRequest` controls how many explicit lookups
each user request may offer (default: 5). The memory module derives availability
from the request's frozen configured limit and existing ledger recall count.
After the limit, both root decision contracts omit `recall_memory` from the
offered schema and action instructions. The request continues with its other
actions; settled memory references and their provenance instructions remain
available. No limit-triggered finalization or separate counter is introduced.
Query changes, empty or unavailable results, and steering do not reset the count.
A new request receives a fresh budget. Automatic terminal retrieval is unchanged.

Only the requesting root's current steering version receives settled recollections.
Steering that supersedes retrieval discards its data before the next decision.
The final response reuses current recall context instead of making an automatic
second search. With no explicit recall, automatic terminal retrieval is unchanged.
Disabled memory adds neither the action nor recall context.

Planner, Worker, Reviewer, payload, and tool contexts do not receive the recall
projection. Stored facts remain passive reference, not user intent, assignments,
action authority, or evidence that an operation completed. Embedding and storage
remain owned by this service; recall adds no retrieval fallback or persistence path.
