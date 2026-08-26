# Architecture

`abot` is a local, embeddable runtime for model-driven requests. It has one
request kernel for conversation, delegated reasoning, tools, artifact work,
and follow-up requests. A model profile selects one registered root contract;
it does not select another runner or state machine.

## Request Path

```text
client or host
  -> RuntimeHost
  -> request handler
  -> canonical root kernel
       -> Supervisor contract or Execution Agent contract
       -> optional registered subordinate calls
       -> policy-authorized capability execution
       -> exact child results return to their caller
  -> root response
  -> request finalizer
```

The canonical root always starts and ends the semantic request. The default
Supervisor contract may respond directly or delegate one bounded objective.
The opt-in Execution Agent contract may execute capabilities directly. The
runtime never chooses a route from prompt words, paths, tool names, or task
categories.

## Role Model

- **Canonical root** owns the root request and final user response.
- **Supervisor** is the default delegated model contract for that root.
- **Execution Agent** is the opt-in direct-capability contract for the same
  root and kernel.
- **Planner** coordinates a bounded sub-process through child role calls.
- **Worker** produces a bounded result and owns concrete capability selection.
- **Reviewer** audits supplied work and returns advisory findings to its caller.

The active role model proposes one strict semantic action. Runtime orchestration
validates and executes that exact action, commits it to the role-call ledger,
and returns child results to the exact caller.

## Canonical Ownership

- `src/runtime/request/` owns the external request boundary, shared root kernel,
  policy composition, and client-facing plan projection.
- `src/runtime/orchestration/role-calls/` is the sole writer of call frames and
  role results.
- `src/runtime/orchestration/role-executors/` mechanically invokes configured
  non-Supervisor roles.
- `src/runtime/orchestration/worker-capabilities/` is the shared capability
  engine and binds selection, execution, payloads, and settled results to the
  exact policy-authorized call.
- `src/runtime/steps/` owns strict model instructions, schemas, parsing, and
  diagnostics for each role.
- `src/runtime/lifecycle/` owns final persistence and request completion.

Events project committed state; they never become a second progress store.

## Tool and Plugin Boundary

Built-in and plugin tools enter one config-filtered `ToolRegistry`. A
policy-authorized model contract sees public normal-invocation contracts and
may select a capability when its objective requires an external observation or
effect. Runtime adapters validate controls, approval, payload, and execution
without deciding the next role or overall completion.

Concrete tool behavior belongs in the tool or plugin. Filesystem and process
policy belongs in their adapters. Core orchestration must not branch on a
specific capability identity.

## Client Events

Planner child-call commits are projected through the existing
`planner.plan.*` event family. For client compatibility those payloads retain
`stage=development_plan`, even though the runtime no longer has a Development
loop. Tool execution keeps the existing `tool.*` event lifecycle.

## Configuration

Runtime config owns installed models, plugin availability, environments, and
the request-runner config reference. Plugin packages own every concrete tool
and skill declaration. The request-runner config owns model-step mappings,
context budgets, and step timeouts only. It does not configure a role
hierarchy, work profile, or fixed role sequence.

Environment profiles isolate generated state. Model profiles select providers
and calibration, and may select one code-owned `execution.policy`. Omission
uses `supervisor-worker-v1`; `execution-agent-v1` is an explicit opt-in. Both
reuse the same kernel, ledger, reducer, capability engine, and finalizer.

## Composition and Public Boundary

Hosts compose the runtime through public package entrypoints:

```ts
import {
  createRuntimeApplication,
  loadRuntimeConfig,
} from "@abot-ai/runtime/runtime";

const config = loadRuntimeConfig({ rootDir: process.cwd() });
const runtime = createRuntimeApplication(config);
await runtime.host.start();
```

`RuntimeApplication` owns one environment service graph and one bound request
handler. A request then owns one `RequestHandlingSession`, immutable
`RequestExecutionScope`, model-step invoker, role-call ledger/transactions,
and capability runtime. Compatibility facades may expose legacy flat fields,
but those fields are getter views of the same request-owned facets rather than
separately assembled state.

The root kernel, role activation loop, capability binding, payload-stage
runner, model invocation, and stream accumulator are lifetime-specific owners
over the same mechanisms. No request-scoped object is reachable through a
global request ID lookup. Process debug and model-I/O loggers remain explicit
process singletons to preserve existing trace routing.

Internal request, orchestration, role-step, model, context, and event modules
are not public API. Session state and request replay remain runtime-owned; a
bridge or UI may relay events but is not the source of truth.

## Generated State

Generated local state is ignored by git:

- `.runtime/`
- `logs/`
- `sessions/`
- `dist/`

Do not publish local sessions, logs, memory, artifacts, or machine-specific
configuration.
