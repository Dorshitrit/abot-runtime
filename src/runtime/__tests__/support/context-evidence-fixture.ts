import {
  reduceContextWindowEvidence,
  type ContextWindowState,
} from "../../../web-ui/app/lib/context-window-state.js";
import { createRealtimeContextHarness } from "./realtime-context-harness.js";

export function contextSnapshotEvent(extra: Record<string, unknown> = {}) {
  return {
    type: "event",
    name: "context.window.snapshot",
    requestId: "request-1",
    invocationId: "invocation-1",
    modelStep: "execution.decision",
    profileId: "luna",
    admissionOutcome: "accepted",
    contextWindowTokens: 32_000,
    estimatedInputTokens: 52_418,
    measuredInputTokens: 21_292,
    eventSequence: 10,
    ...extra,
  };
}

export function compactionEvent(
  phase: string,
  sequence: number,
  invocationId = "outer-1",
  extra: Record<string, unknown> = {},
) {
  return {
    type: "event",
    name: `context.compaction.${phase}`,
    requestId: "request-1",
    invocationId,
    eventSequence: sequence,
    modelStep: "execution.decision",
    profileId: "luna",
    beforeInputTokens: 28_271,
    afterInputTokens: 12_049,
    contextWindowTokens: 32_000,
    ...extra,
  };
}

export function createScopedContextHarness() {
  const harness = createRealtimeContextHarness();
  harness.state.requestLifecycles.set("request-1", {
    schemaVersion: 1,
    requestId: "request-1",
    generation: "generation-1",
    revision: 1,
    status: "streaming",
  });
  const send = (event: Record<string, unknown>) =>
    harness.controller.handle({
      sessionId: "session-1",
      environment: "environment-1",
      generation: "generation-1",
      ...event,
    });
  const current = () =>
    harness.state.contextWindowByRequest.get("request-1") as
      | ContextWindowState
      | undefined;
  return { ...harness, send, current };
}

export function buildContextFixture(
  requestId: string,
  snapshot: Record<string, unknown> = {},
  following: Record<string, unknown>[] = [],
) {
  const scope = {
    requestId,
    environmentId: "environment-1",
    sessionId: "session-1",
    generation: "",
    requestKnown: true,
  };
  let current = reduceContextWindowEvidence(
    undefined,
    contextSnapshotEvent({
      requestId,
      invocationId: `invocation-${requestId}`,
      measuredInputTokens: undefined,
      estimatedInputTokens: 3_120,
      contextWindowTokens: 10_000,
      modelStep: "worker.decision",
      profileId: "local",
      ...snapshot,
    }),
    scope,
  );
  for (const [index, event] of following.entries()) {
    current = reduceContextWindowEvidence(
      current,
      { requestId, eventSequence: index + 20, ...event },
      scope,
    );
  }
  return current!;
}
