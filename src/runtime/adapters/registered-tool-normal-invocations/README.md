# Registered tool normal invocations

This directory implements the request-scoped ordinary invocation boundary while
`../registered-tool-normal-invocations.ts` preserves its stable public entry
point.

- `executor.ts` captures the selected registry snapshot and composes execution.
- `catalog/` owns registration capture and runtime-path projections.
- `payload/` owns public input preparation and payload lifecycle events.
- `execution/` owns call binding, approval, execution, and completion events.
- `shared/` owns contracts and small cross-cutting primitives.
