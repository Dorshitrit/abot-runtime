# Passive long-term memory

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

Only terminal response authoring may receive the bounded passive projection.
Decision, planning, worker, reviewer, payload, and tool contexts must not import
or project this package's records.
