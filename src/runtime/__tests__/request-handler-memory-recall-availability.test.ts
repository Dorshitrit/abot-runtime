import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { isRequestExecutionScope } from "../request/execution-scope.js";
import { handleRunRequest } from "../request/handler.js";
import * as requestRunner from "../request/runner.js";
import {
  createMemoryRecallHarness,
  FINAL_RESPONSE,
  RECALL_QUERY,
  REQUEST_PROMPT,
  responseDecision,
} from "./support/memory-recall-runner.js";
import {
  createRuntimeConfig,
  disposeCompositionFixtures,
} from "./support/runtime-composition-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.restoreAllMocks();
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

test.each([
  ["execution-agent-v1", 2],
  ["execution-agent-v1", 7],
  ["supervisor-worker-v1", 2],
  ["supervisor-worker-v1", 7],
] as const)(
  "%s carries configured recall availability %s through the handler and real runner",
  async (policy, limit) => {
    const offered: boolean[] = [];
    const harness = createMemoryRecallHarness({
      policy,
      decide(input) {
        const recallOffered = JSON.stringify(input.format).includes(
          '"recall_memory"',
        );
        offered.push(recallOffered);
        if (!recallOffered || offered.length > limit)
          return responseDecision(policy);
        return {
          action: "recall_memory",
          query: RECALL_QUERY,
          ...(offered.length === 1
            ? { acknowledgement: "I will check the stored preference." }
            : {}),
        };
      },
    });
    const runtimeConfig = {
      ...(await createRuntimeConfig()),
      plugins: { enabled: false },
      longTermMemory: {
        enabled: true,
        emitClientEvents: false,
        maxRecallCallsPerRequest: limit,
      },
      models: harness.request.modelPolicy,
      modelExecutionPolicies: { test: { policy } },
    };
    await writeFile(
      runtimeConfig.requestRunner.configPath!,
      JSON.stringify({
        schemaVersion: 2,
        models: { defaults: { profileId: "test", steps: {} } },
        context: {
          outputReserveTokens: 1000,
          safetyReserveTokens: 200,
          attachmentReserveTokens: 100,
        },
        stepDefaults: { timeoutMs: 1000 },
        steps: {},
      }),
    );
    const sessionStore = createInMemorySessionStore();
    await sessionStore.getOrCreateSession("recall-session");
    await sessionStore.updateSessionTitle("recall-session", "Saved preference");
    const runnerSpy = vi.spyOn(requestRunner, "runRequestRunner");
    const events: Record<string, unknown>[] = [];
    const ws = {
      send(data: string) {
        events.push(JSON.parse(data));
      },
    } as unknown as WebSocket;

    await handleRunRequest(
      ws,
      {
        type: "run_request",
        requestId: "configured-recall-request",
        sessionId: "recall-session",
        input: REQUEST_PROMPT,
        agentMode: "reasoning",
        modelPreference: { profileId: "test", scope: "all" },
      },
      {
        runtimeConfig,
        sessionStore,
        modelGatewayClient: {
          invoke: harness.invoke,
          invokeRaw: harness.invokeRaw,
        },
        longTermMemory: harness.memory,
      },
    );

    expect(runnerSpy).toHaveBeenCalledOnce();
    const request = runnerSpy.mock.calls[0]![0];
    expect(isRequestExecutionScope(request)).toBe(true);
    expect(request.memoryRecallLimit).toBe(limit);
    expect(request.executionPolicy.authority.id).toBe(policy);
    expect(offered).toEqual([...Array<boolean>(limit).fill(true), false]);
    expect(harness.memory.retrieve).toHaveBeenCalledTimes(limit);
    expect(harness.invokeRaw).not.toHaveBeenCalled();
    expect(
      harness.invoke.mock.calls.some(
        ([input]) => input.modelStep === "degraded.finalization",
      ),
    ).toBe(false);
    expect(events.filter(({ type }) => type === "failed")).toEqual([]);
    expect(events.filter(({ type }) => type === "completed")).toEqual([
      expect.objectContaining({ output: FINAL_RESPONSE }),
    ]);
    const session = await sessionStore.getSessionById("recall-session");
    expect(session?.messages.at(-1)).toMatchObject({
      role: "assistant",
      requestId: "configured-recall-request",
      content: FINAL_RESPONSE,
    });
  },
);
