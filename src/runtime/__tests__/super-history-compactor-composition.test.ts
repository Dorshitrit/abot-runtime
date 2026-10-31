import { afterEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import type { SessionRequestLifecycleSnapshot } from "../../sessions/request-lifecycle/contracts.js";
import {
  createDefaultRuntimeDependencies,
  createRuntimeRequestHandler,
  type RuntimeEnvironmentServices,
  type RuntimeRequestHandler,
} from "../composition.js";
import {
  createRuntimeEnvironment,
  rebindRuntimeEnvironmentEvents,
  recomposeRuntimeEnvironment,
} from "../runtime-environment.js";
import { resolveRuntimeHostEnvironmentServices } from "../runtime-host-environment.js";
import { resolveRequestDependencies } from "../request/dependencies.js";
import { validateApprovalResume } from "../request/approval-wait/preflight.js";
import type { RequestApprovalSnapshot } from "../request/approval-wait/snapshot.js";
import { generateSessionMemorySummary } from "../context/session-memory/compaction/run.js";
import * as sessionMemory from "../context/session-memory/index.js";
import * as memorySnapshot from "../context/session-memory/snapshot.js";
import { SESSION_MEMORY_COMPACTORS } from "../context/super-compaction/history-routing.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
});

function runRequest(handler: RuntimeRequestHandler, requestId: string) {
  return handler.handle({ send() {} } as unknown as WebSocket, {
    type: "run_request",
    requestId,
    sessionId: "session",
    text: "Answer briefly.",
    agentMode: "reasoning",
    toolPermissionMode: "ask",
    modelPreference: { profileId: "scheduled-model", scope: "all" },
  });
}

test.each(["supervisor-worker-v1", "execution-agent-v1"] as const)(
  "default composed handler binds the %s history author",
  async (policy) => {
    const f = await createSchedulerRuntimeFixture(policy);
    cleanup.push(f.dispose);
    const pair = f.application.services[SESSION_MEMORY_COMPACTORS]!;
    const create = vi.spyOn(sessionMemory, "createRequestSessionMemory");
    await f.runOrdinaryRequest("Answer briefly.");
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0].scope).toBe(
      policy === "execution-agent-v1" ? "execution_agent" : undefined,
    );
    expect(create.mock.calls[0]![0].compactor).toBe(
      policy === "supervisor-worker-v1" ? pair.super : pair.legacy,
    );
    expect(pair.legacy.compact).toBe(generateSessionMemorySummary);
    expect(pair.super).not.toBe(pair.legacy);
    expect(Object.isFrozen(pair)).toBe(true);
  },
);

test("the public dependency facade retains routing without adding an enumerable field", async () => {
  const f = await createSchedulerRuntimeFixture();
  cleanup.push(f.dispose);
  const facade = createDefaultRuntimeDependencies(f.config, {
    models: { invoke: f.invoke, invokeRaw: f.invokeRaw },
  });
  const pair = (facade as RuntimeEnvironmentServices)[
    SESSION_MEMORY_COMPACTORS
  ]!;
  const create = vi.spyOn(sessionMemory, "createRequestSessionMemory");
  await runRequest(createRuntimeRequestHandler(facade), "facade-history");
  expect(create.mock.calls[0]![0].compactor).toBe(pair.super);
  expect(
    Object.getOwnPropertyDescriptor(facade, SESSION_MEMORY_COMPACTORS),
  ).toMatchObject({ enumerable: false, value: pair });
  expect(JSON.stringify({ [SESSION_MEMORY_COMPACTORS]: pair })).toBe("{}");
});

test("approval hydration restores the frozen SUPER author despite current EA configuration", async () => {
  const f = await createSchedulerRuntimeFixture("execution-agent-v1");
  cleanup.push(f.dispose);
  const stoppedAtRestore = new Error("test_history_restore_boundary");
  const restore = vi
    .spyOn(memorySnapshot, "restoreRequestSessionMemory")
    .mockImplementation(() => {
      throw stoppedAtRestore;
    });
  const { snapshot, current } = approvalBoundary();
  await expect(
    validateApprovalResume(f.application.services, snapshot, current),
  ).rejects.toBe(stoppedAtRestore);
  expect(restore).toHaveBeenCalledOnce();
  expect(restore.mock.calls[0]![1].compactor).toBe(
    f.application.services[SESSION_MEMORY_COMPACTORS]!.super,
  );
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.invokeRaw).not.toHaveBeenCalled();
});

test("host composition and rebinding preserve defaults while a custom override wins", async () => {
  const f = await createSchedulerRuntimeFixture();
  cleanup.push(f.dispose);
  const services = f.application.services;
  const pair = services[SESSION_MEMORY_COMPACTORS]!;
  const events = { create: services.events.create };
  expect(
    rebindRuntimeEnvironmentEvents(services, events)?.[
      SESSION_MEMORY_COMPACTORS
    ],
  ).toBe(pair);
  const recomposed = recomposeRuntimeEnvironment(f.config, services, {
    sessionMemoryCompactor: services.sessionMemoryCompactor,
  });
  expect(recomposed[SESSION_MEMORY_COMPACTORS]).toBe(pair);
  const host = resolveRuntimeHostEnvironmentServices({
    config: f.config,
    defaults: {},
    options: {},
  })!;
  expect(host[SESSION_MEMORY_COMPACTORS]!.super).not.toBe(
    host.sessionMemoryCompactor,
  );
  const custom = { compact: vi.fn(async () => "Custom history") };
  const overridden = recomposeRuntimeEnvironment(f.config, services, {
    sessionMemoryCompactor: custom,
  });
  expect(overridden.sessionMemoryCompactor).toBe(custom);
  expect(overridden[SESSION_MEMORY_COMPACTORS]).toEqual({
    legacy: custom,
    super: custom,
  });
  const direct = createRuntimeEnvironment(f.config, {
    sessionMemoryCompactor: custom,
  });
  cleanup.push(direct.stop);
  const dependencies = resolveRequestDependencies({
    sessionMemoryCompactor: custom,
    [SESSION_MEMORY_COMPACTORS]: pair,
  });
  expect(dependencies.sessionMemoryCompactor).toBe(custom);
  expect(dependencies.superSessionMemoryCompactor).toBe(custom);
});

/** The real preflight and preparation run up to the session-memory restore seam. */
function approvalBoundary() {
  const current: SessionRequestLifecycleSnapshot = {
    schemaVersion: 1,
    sessionId: "session",
    requestId: "history-resume",
    generation: "generation",
    status: "awaiting_approval",
    revision: 1,
    activation: { activationId: "activation", ownerEpoch: "owner" },
    decisionReceipts: [],
    wait: {
      waitId: "wait",
      createdAt: "2026-10-24T00:00:00Z",
      presentationMessageId: "message",
      approvals: [
        {
          approvalId: "approval",
          actionFingerprint: "fingerprint",
          presentation: {},
        },
      ],
    },
  };
  // Fields consumed after restore are deliberately excluded from this boundary fixture.
  const snapshot = {
    kind: "request_approval_snapshot_v1",
    originalPrompt: "Answer briefly.",
    requestWorkingDirectory: "/tmp",
    toolAttachments: [],
    seed: {
      sessionId: current.sessionId,
      requestId: current.requestId,
      prompt: "Answer briefly.",
      agentMode: "reasoning",
      toolPermissionMode: "ask",
      shouldGenerateSessionTitle: false,
      historyMessages: [],
      modelPreference: { profileId: "scheduled-model", scope: "all" },
      executionPolicySelection: {
        policy: "supervisor-worker-v1",
        source: "model_profile",
      },
    },
    runner: {
      preparedGroup: {
        requestId: current.requestId,
        entries: [
          {
            actionFingerprint: "fingerprint",
            approvalRequest: { approvalId: "approval" },
          },
        ],
      },
    },
    sessionMemory: {},
    presentation: { answerText: "", thinkingText: "", thinkingTrace: [] },
    steering: { version: 0, updates: [] },
    budgets: {
      requestTimeoutMs: 0,
      inactivityTimeoutMs: 0,
      requestRemainingMs: 0,
      inactivityRemainingMs: 0,
    },
  } as unknown as RequestApprovalSnapshot;
  return { snapshot, current };
}
