# Runtime Model and Policy Contracts

Model instructions are runtime behavior whenever output is parsed into a strict
decision. The runtime has one canonical root kernel and RoleCall ledger. A
request-frozen execution policy selects the model-facing root and subordinate
contracts without selecting a fixed workflow.

## Structured Model Boundaries

| Boundary                   | Instructions and schema                                                                                               | Executable validation                                                                                                                                                                                                                     | Primary coverage                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supervisor decision        | `src/runtime/steps/supervisor-decision/`                                                                              | strict parser, default-policy child contracts, exact canonical root, and runtime-owned receipt plus verified lineage for returned Planner/Worker results                                                                                  | `supervisor-decision.test.ts`, `role-call-work-receipt-continuation-pr1.test.ts`, `supervisor-request-runner.test.ts`                                                                                    |
| Supervisor response        | `src/runtime/steps/supervisor-response/`                                                                              | exact active root and bounded returned-child context; legacy normalized terminal mode                                                                                                                                                     | `supervisor-response.test.ts`, `supervisor-request-runner.test.ts`, `request-finalization.test.ts`                                                                                                       |
| Execution Agent decision   | `src/runtime/steps/execution-agent/`                                                                                  | strict parser, direct-policy actions and root capability authority, exact canonical state                                                                                                                                                 | `execution-agent-decision.test.ts`, `execution-agent-request-runner.test.ts`                                                                                                                             |
| Execution Agent response   | `src/runtime/steps/execution-agent/response-*`                                                                        | raw non-empty bounded text from the exact accepted response state; direct-policy exact terminal mode only                                                                                                                                 | `execution-agent-request-runner.test.ts`, `request-finalization.test.ts`                                                                                                                                 |
| Delegated Planner decision | `src/runtime/steps/planner-decision/`                                                                                 | strict parser, exact Planner caller, registered delegated child contracts, complete known plan declaration, one-Worker-item dispatch, and runtime-owned receipt plus verified lineage for the returned Worker                             | `planner-decision.test.ts`, `planner-plan-contract.test.ts`, `role-call-work-receipt-continuation-pr1.test.ts`, `role-call-planner-events.test.ts`                                                       |
| Planner Graph advisory     | `src/runtime/steps/planner-graph/`                                                                                    | bounded acyclic proposal or decline from the exact advisory objective; no execution authority                                                                                                                                             | `execution-agent-advisory-executors.test.ts`, `execution-agent-request-runner.test.ts`                                                                                                                   |
| Worker decision            | `src/runtime/steps/worker-decision/`                                                                                  | strict parser, exact Worker activation, offered capability catalog, and compact receipts for explicit dependency results; a directly bound Planner item excludes the broader request, Planner objective, and sibling tool-result lane     | `worker-decision.test.ts`, `worker-capability-decision.test.ts`, `role-call-dependency-work-receipt-pr1.test.ts`, `planner-worker-context-isolation.test.ts`, `planner-worker-tool-result-scope.test.ts` |
| Worker result              | `src/runtime/steps/worker-decision/result-author.ts`                                                                  | raw text from the exact projected Worker assignment and evidence; Planner-item results retain the same narrowed boundary                                                                                                                  | `worker-decision.test.ts`, `planner-worker-context-isolation.test.ts`, `supervisor-request-runner.test.ts`                                                                                               |
| Reviewer decision          | `src/runtime/steps/reviewer-decision/`                                                                                | strict parser and bounded supplied-work projection                                                                                                                                                                                        | `reviewer-decision.test.ts`, `supervisor-request-runner.test.ts`                                                                                                                                         |
| Auditor advisory           | `src/runtime/steps/auditor-decision/`                                                                                 | typed criteria, whole canonical evidence entries, and omission-gated pass                                                                                                                                                                 | `execution-agent-advisory-executors.test.ts`, `execution-agent-request-runner.test.ts`                                                                                                                   |
| Capability payload         | `src/runtime/orchestration/worker-capabilities/payload-author.ts`, `src/runtime/request/worker-capability-payload.ts` | frozen-policy Worker or root principal, selected operation, immutable controls and payload contract; only a runtime-issued direct-Planner-item receipt can omit source; work-result receipts and lineage are removed before raw authoring | `planner-worker-context-isolation.test.ts`, `worker-capability-payload-author.test.ts`, `worker-payload-dependency-projection-pr1.test.ts`, `execution-agent-request-runner.test.ts`                     |
| Degraded finalization      | `src/runtime/steps/degraded-finalization/`                                                                            | bounded failure rendering only                                                                                                                                                                                                            | `degraded-finalization.test.ts`, `request-finalization.test.ts`                                                                                                                                          |

Instructions explain semantic choices. Parsers validate exact output shapes.
The RoleCall ledger and shared capability binding remain the executable
authority; prompt text never writes canonical state.

## Configured Root Response Methodology

`supervisor.response` and `execution.response` share the configured
`response-ux.md` and `memory-informed-response.md` references. The first is
always-active editorial guidance. The second governs restrained use of the
optional passive long-term-memory projection. Neither methodology changes the
response schema, current user intent, evidence requirements, routing, action,
or completion authority.

## Authority Rules

- Every request has one canonical root. The frozen policy selects its
  Supervisor or Execution Agent model-facing contract; only that root can
  return the final user-facing response.
- Omission selects `supervisor-worker-v1` and preserves the delegated MAIN
  contract. A configured profile may explicitly select `execution-agent-v1`;
  there is no prompt-based selection or mid-request fallback.
- An active role model alone chooses its next semantic action.
- The delegated Planner coordinates a bounded sub-process. Before its first
  child dispatch it declares every currently known execution outcome, then
  binds exactly one independently completable production item whenever it
  dispatches Worker. A later activation may select the next pending production
  item after consuming the bound Worker result. Other registered child-role
  contracts are unchanged. `planner.graph` is a distinct direct-policy advisory that only
  proposes or declines a bounded graph; neither gains root response authority.
- Worker owns capability selection under `supervisor-worker-v1`; the canonical
  root owns it under `execution-agent-v1`. Both use the same binding, payload
  author, adapter execution, and settlement mechanics.
- Reviewer returns advisory findings to its exact caller. Runtime code does not
  automatically remediate or finalize from a verdict.
- Under `supervisor-worker-v1`, the runtime alone issues `work_result_v1` for a
  terminal Planner or Worker result. The exact caller may receive the compact
  receipt and a fingerprint-verified lineage projection derived from the
  canonical ledger. They establish provenance only; the active model still
  owns the semantic next action and must not treat them as proof of correctness.
  Model-supplied receipts are rejected and `execution-agent-v1` is unchanged.
- Auditor returns a passive verdict over explicitly supplied criteria and whole
  evidence entries. Missing or omitted evidence cannot produce pass.
- `reconsider_capability_selection` is a canonical mechanical transition after
  direct controls refinement exhausts structured-output validation. It
  executes nothing, makes no semantic judgment, chooses no replacement, and
  cannot be treated as tool evidence or completion.
- A child result returns only to its exact caller frame.
- Runtime code must not infer role choice from prompt words, paths, tool names,
  task categories, or model prose.

## Editing Rule

When changing a model or policy boundary, update its owner and matching
coverage:

- decision shape: prompt, format, parser, and role test;
- execution-policy authority: code-owned policy composition, RoleCall reducer,
  and cross-policy negative controls;
- call legality: role-call reducer/registry and ledger tests;
- capability contract: shared capability binding/payload author or concrete
  adapter tests;
- client presentation: post-commit event projector and event-contract tests;
- final persistence: request finalizer and session/request tests.

Keep production guidance generic. Concrete tool behavior belongs to the tool or
plugin, and client presentation must never become orchestration state.
