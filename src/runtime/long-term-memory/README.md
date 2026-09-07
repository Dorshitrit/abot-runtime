# Long-term memory

This package owns cross-session memory retrieval, reconciliation, persistence,
and management. It is a core Runtime service, not a model-facing capability and
not a dependency on `plugins/memory`.

Passive candidates are scheduled on the service-owned background save queue
after the terminal response is persisted. The request lifecycle does not await
embedding or store work; queue failures and deadlines remain memory diagnostics
and cannot change the completed user response.

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
