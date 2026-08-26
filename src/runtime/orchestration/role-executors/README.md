# Role executors

This directory owns the mechanical execution boundary between registered runtime
roles and the role-call ledger.

- `registry.ts` composes registered executors and exposes the stable registry
  facade.
- `activation/` owns one role's activation loop, result normalization, and
  capability-continuation validation.
- `child-invocation/` owns the open-execute-return transaction for delegated
  child roles and validates its ledger projections.
- `shared/` contains invariants and diagnostic-context construction used by
  both lifecycles.
- `contracts.ts` and `diagnostics.ts` remain the stable contracts and
  observability boundary.

These modules must not choose semantic workflow. They enforce the ledger,
continuation, and registration contracts around decisions made by role
executors.
