# Role executors

This directory owns the mechanical execution boundary between registered runtime
roles and the role-call ledger.

- `registry.ts` composes registered executors and exposes the stable registry
  facade.
- `activation/` owns one role's activation loop, result normalization, and
  capability-continuation validation.
- `child-invocation/` owns the open-execute-return transaction for delegated
  child roles, transports optional policy-bound result receipts, and validates
  their ledger projections.
- `shared/` contains invariants and diagnostic-context construction used by
  both lifecycles.
- `contracts.ts` and `diagnostics.ts` remain the stable contracts and
  observability boundary.

These modules must not choose semantic workflow. They enforce the ledger,
continuation, and registration contracts around decisions made by role
executors. Transporting a receipt does not grant it completion authority.

Recognized model-output validation failures after repair exhaustion, and typed
provider output truncation and local model-step timeouts bound to the active
child step, are contained around the active executor call. They return a passive
failed result to the exact caller
through the existing terminal normalization and child-return transaction.
Planner and Worker failures retain runtime-issued work receipts; an invalid
Reviewer output does not acquire a review verdict. Existing model repair
budgets are unchanged; truncated or timed-out output is not retried or treated
as evidence. Advisory `planner.graph` and `auditor.decision` failures bind to
their canonical Planner and Reviewer calls. Request cancellation and the
request-wide deadline retain priority over a local step timeout.
Other provider errors, cancellation, unrecognized failures,
and stale or invalid ledger transitions still propagate as failures.
