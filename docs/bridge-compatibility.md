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
