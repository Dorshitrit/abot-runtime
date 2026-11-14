# Bridge Compatibility

`abot` can be embedded directly by a host application or connected to a
bridge service. The bridge is transport infrastructure. It should not own the
runtime state model.

The source-checkout Web UI uses the direct local runtime transport by default.
This is separate from the external bridge path, so private clients that use
their own bridge can keep using the existing bridge protocol.

## Ownership

The runtime owns:

- session storage
- request event persistence
- replayable request state
- final assistant output
- tool routing and execution
- model calls through the configured gateway

The bridge owns:

- client connectivity
- authentication at the transport edge
- live event delivery
- request forwarding
- reconnect and delivery mechanics

Clients should be able to recover from runtime-backed session snapshots and
request replay after reconnecting.

## Optional Presentation Fields

A `completed` event may include `disposition: "blocked"` when the execution
policy has produced a blocked terminal result. The request still has a final
output, but clients should display it as blocked instead of successful. The
same field is retained in replay and the request's `finalState`. Existing sinks
that accept only `completed(output)` remain supported; ordinary completions and
older records omit the field. Clients should not infer this value from answer
text.

Role status (`runtime.state`) and tool events may include `presentationRole`
with `"execution_agent"` or `"auditor"`. These values supply display names for
the canonical `supervisor` and `reviewer` roles respectively. Canonical role IDs,
event names, request routing, and stored model history remain unchanged. Use the
recorded field for live and replayed events; when absent, retain the canonical
role's existing presentation rather than infer it from the currently selected
profile.

## `runtimeId` And Legacy `agentId`

Runtime config and public examples use `runtimeId` to identify the running
runtime instance or environment.

Some bridge-facing protocol fields may still be named `agentId` for
compatibility with existing bridge clients. That field name is transport
compatibility only. It does not mean the runtime has a multi-agent management
model.

When adapting a bridge:

- map the runtime's `runtimeId` to the bridge protocol field expected by the
  bridge
- keep environment names as `prod`, `dev`, or another host-defined profile
- do not introduce agent names such as `main` unless the host actually has an
  agent-management layer
- keep request/session source of truth inside the runtime

## Expected Flow

```text
client
  -> bridge transport
  -> runtime host
  -> runtime sessions/events/tools/model gateway
```

The bridge may cache live delivery state, but durable recovery should come from
runtime-owned session and request state.

## Active Request Steering

Runtime bridge registration advertises optional protocol features. When
`request_steering_v1` is present, the bridge may forward a later user message
to the same active request:

```json
{
  "type": "steer_request",
  "requestId": "request-id",
  "steerId": "client-idempotency-id",
  "text": "Use the shorter format instead"
}
```

The runtime responds with a correlated `steer_ack` and an
`acceptedSequence`, or rejects it when the request is no longer active. The
runtime preserves message order and idempotency but does not interpret whether
the message means refine, redirect, add work, or stop. That remains a model
decision at the next safe model boundary.

Capability discovery is automatic: clients keep their legacy queue behavior
while the feature is absent and may enable steering after the runtime
reconnects and advertises it. No separate runtime flag or client refresh is
required.

## Recoverable Tool Approvals

Managed request handlers expose an optional `approvalControls` transport facet.
When that complete facet is available, registration advertises
`request_approvals_v1`. Embedded or standalone handlers without it retain their
existing live approval behavior. A bridge opts a new `run_request` into saved
approvals with `approvalMode: "durable_v1"`; omitting it keeps the legacy path.
Requesting it from an unsupported handler fails instead of silently downgrading.

The runtime remains the authority for pending approvals, decisions and execution.
The transport does not reconstruct permission from replayed events, introduce an
approval expiry, or store executable continuations. Saved waits use the same
mechanism as the Web UI and survive a runtime restart. Old live-only requests
cannot be converted into saved waits from historical events.

To recover a particular request, send:

```json
{
  "type": "request.approvals.request",
  "correlationId": "recovery-call-id",
  "sessionId": "session-id",
  "requestId": "request-id"
}
```

The corresponding `request.approvals.response` echoes all three identities and
returns `ok`, current pending `approvals`, safe `lifecycle` metadata and
`finalState`. Each pending entry contains the approval `request`; a saved entry
also includes `wait: { generation, waitId, revision }`. Recovery attaches event
delivery only for the exact request. It does not approve, rerun or resume work.
An empty list alone is not evidence that a request completed.

Decisions use a separate correlated call:

```json
{
  "type": "request.approval.decide.request",
  "correlationId": "decision-call-id",
  "sessionId": "session-id",
  "requestId": "request-id",
  "approvalId": "approval-id",
  "generation": "saved-request-generation",
  "waitId": "saved-wait-id",
  "revision": 3,
  "commandId": "stable-decision-id",
  "approved": true
}
```

The `request.approval.decide.response` echoes the routing identities and returns
the owner's decision `result`. A successful transport send is not acceptance.
Use the identity shown with the approval, rather than replacing a stale identity
with the latest one. Preserve `commandId` when reconciling an uncertain outcome;
the owner uses its existing decision receipts to avoid consuming a decision twice.
Resumed events continue on the normal request stream. Neither recovery nor
decision handling guarantees exactly-once external tool effects after a crash.

The external bridge must authenticate clients and preserve its own bounded
owner/runtime/session/request routing bindings across its restart. Those bindings
authorize access to the runtime's current state; they are not approval state.
Never infer ownership or permission from a client-provided identifier, a session
snapshot or replay. Scope recovery and decision responses to the active runtime
connection, and discard responses from replaced connections.

## SPARK Companion Chat

Handlers with the optional `sparkChat` facet advertise `spark_chat_v1`.
The feature indicates protocol support, not that a SPARK model is configured.
Open the environment's canonical companion with a correlated request:

```json
{ "type": "spark.chat.open.request", "correlationId": "open-spark" }
```

The `spark.chat.open.response` echoes `correlationId` and returns `ok: true`,
`sessionId`, `modelProfileId`, `toolPermissionMode` and `readiness`. Readiness is
`ready`, `model_required` or `model_unavailable`. Opening creates or reuses the
marked SPARK session without starting a model request. A conflicting unmarked
session is rejected instead of being converted. Load its messages and waiting
requests through the existing session snapshot and approval recovery commands.

Send messages through `run_request` with the returned `sessionId` and an explicit
`toolPermissionMode`. The external relay must validate that mode against the
authenticated client's runtime grant, just as it does for an ordinary request.
At every new SPARK request, the runtime rereads its SPARK preferences and requires
the incoming mode to match. A missing or changed mode fails with
`spark_chat_permission_mismatch`; refresh the SPARK state and let the user retry.
Do not automatically resend a request whose outcome is unknown.

The runtime applies the configured SPARK model rather than the ordinary chat's
model selection. Missing or unavailable models fail before execution. Model
availability is checked against the running environment's configuration; chat
availability does not depend on its collection or proactive-activity toggles.
An unsupported handler rejects SPARK requests with `spark_chat_unsupported`
instead of creating an ordinary conversation under the reserved identifier.

Existing steering, event replay and negotiated durable approvals remain in use.
Resuming a saved approval retains its captured request policy; it does not reread
SPARK settings or start a new request. This capability does not expose SPARK
configuration writes, autonomous notifications, jobs or dashboard management.

## Web UI Transport

The Web UI server supports two transport backends:

- `runtime`: direct local in-process runtime transport. This is the default.
- `bridge`: compatibility proxy to an external bridge that implements the
  runtime bridge HTTP and realtime contract.

Select the bridge proxy explicitly:

```bash
LLM_RUNTIME_WEB_BACKEND=bridge npm run web-ui
```

The direct Web UI transport does not change bridge registration, bridge
authentication, or private app traffic.

## External Bridge Adapter Contract

An external bridge can be private, public, local, or hosted. The runtime only
requires it to expose the bridge transport configured for the Web UI:

```text
LLM_RUNTIME_WEB_BACKEND=bridge
LLM_RUNTIME_WEB_API_BASE_URL=http://127.0.0.1:8787/abot/api
LLM_RUNTIME_WEB_REALTIME_URL=ws://127.0.0.1:8787/abot/realtime
LLM_RUNTIME_WEB_HEALTH_URL=http://127.0.0.1:8787/abot/health
LLM_RUNTIME_WEB_AGENT_MODE_URL=http://127.0.0.1:8787/abot/agent-mode
LLM_RUNTIME_WEB_API_TOKEN=<bridge token>
```

The Web UI forwards `/web-api/*` to the configured API base path, forwards
`/web-realtime` to the configured realtime WebSocket, and forwards health and
mode checks to their configured endpoints.

For compatibility with bridge protocols that still use legacy naming, the
external bridge adapter mirrors `environment` or `environmentId` into
`agentId`. This compatibility mapping is isolated to the external bridge
adapter; runtime config and public examples remain environment-based.
