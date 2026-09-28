import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import { SessionService } from "../../session-service.js";
import type {
  SessionActivationExpectation,
  SessionLifecycleMutationResult,
  SessionRequestLifecycleSnapshot,
  SessionWaitExpectation,
} from "../contracts.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

export function accepted(result: SessionLifecycleMutationResult) {
  expect(result.accepted).toBe(true);
  if (!result.accepted) throw new Error(result.reason);
  return result;
}

export function activationExpected(
  state: SessionRequestLifecycleSnapshot,
): SessionActivationExpectation {
  if (!state.activation) throw new Error("activation_required");
  return {
    requestId: state.requestId,
    generation: state.generation,
    revision: state.revision,
    ...state.activation,
  };
}

export function waitExpected(
  state: SessionRequestLifecycleSnapshot,
): SessionWaitExpectation {
  if (!state.wait) throw new Error("wait_required");
  return {
    requestId: state.requestId,
    generation: state.generation,
    revision: state.revision,
    waitId: state.wait.waitId,
  };
}

export async function fixture(approvalCount = 1) {
  const root = join(
    process.cwd(),
    ".codex",
    "artifacts",
    "ask-approval-implementation-20260928",
  );
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "storage-fixture-"));
  directories.push(directory);
  const service = new SessionService({
    sessionsDir: directory,
    now: () => new Date("2026-09-28T10:00:00Z"),
  });
  await service.appendMessage(
    "conversation",
    "user",
    "Perform the requested action.",
    { requestId: "request" },
  );
  const started = accepted(
    await service.requestLifecycle.startActivation("conversation", {
      requestId: "request",
      activationId: "activation-1",
      ownerEpoch: "owner-1",
    }),
  );
  const continuation = await service.requestLifecycle.writeContinuation(
    "conversation",
    {
      schema: "test-continuation",
      version: 1,
      value: { exactAction: "fixture", previousResult: "already done" },
    },
  );
  const approvals = Array.from({ length: approvalCount }, (_value, index) => ({
    approvalId: `approval-${index + 1}`,
    actionFingerprint: `action-${index + 1}`,
    presentation: { tool: "fixture", summary: `Action ${index + 1}` },
  }));
  const command = {
    expected: activationExpected(started.current),
    waitId: "wait-1",
    approvals,
    continuation,
    presentationText: "Please approve the prepared action.",
  };
  return { service, directory, started, continuation, approvals, command };
}
