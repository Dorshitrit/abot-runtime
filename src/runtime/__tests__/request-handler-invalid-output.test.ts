import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import type { ModelGatewayClient } from "../ports.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { handleRunRequest } from "../request/handler.js";
import {
  createRuntimeConfig,
  disposeCompositionFixtures,
} from "./support/runtime-composition-fixture.js";
import { createMemoryRecallHarness } from "./support/memory-recall-runner.js";
import {
  INVALID_OUTPUT_MODEL_POLICY,
  ROOT_OUTPUT_POLICIES,
  rootRespondOutput,
} from "./support/root-invalid-output-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.restoreAllMocks();
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

describe.each(ROOT_OUTPUT_POLICIES)(
  "$policyId invalid-output client lifecycle",
  (policy) => {
    test.each([
      ["decision", "valid"],
      ["response", "valid"],
      ["decision", "invalid"],
      ["response", "invalid"],
      ["decision", "provider_failure"],
      ["response", "provider_failure"],
    ] as const)(
      "invalid %s with %s degraded output publishes only a model-authored answer",
      async (phase, degradedOutcome) => {
        const { memory } = createMemoryRecallHarness({
          policy: policy.policyId,
          decide: () => {
            throw new Error("unused harness model");
          },
        });
        const runtimeConfig = {
          ...(await createRuntimeConfig()),
          plugins: { enabled: false },
          longTermMemory: { enabled: true, emitClientEvents: false },
          models: INVALID_OUTPUT_MODEL_POLICY,
          modelExecutionPolicies: {
            "invalid-output-test": { policy: policy.policyId },
          },
        };
        await writeFile(
          runtimeConfig.requestRunner.configPath!,
          JSON.stringify({
            schemaVersion: 2,
            models: {
              defaults: { profileId: "invalid-output-test", steps: {} },
            },
            context: {
              outputReserveTokens: 1_000,
              safetyReserveTokens: 200,
              attachmentReserveTokens: 100,
            },
            stepDefaults: { timeoutMs: 20_000 },
            steps: {},
          }),
        );
        const rejectedMemory = {
          content: "Uncommitted memory must not survive response failure.",
          tags: ["uncommitted"],
        };
        const phrasing = {
          failureNotice: "I could not safely finish the requested work.",
          nextStep: "Continue with the recorded state in a follow-up request.",
        };
        const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
          if (input.modelStep === "degraded.finalization") {
            if (degradedOutcome === "provider_failure")
              throw new Error("degraded_provider_connection_failed");
            return {
              text: degradedOutcome === "valid" ? JSON.stringify(phrasing) : "",
              meta: {},
            };
          }
          if (phase === "response" && input.modelStep === policy.decisionStep)
            return { text: rootRespondOutput(policy.policyId), meta: {} };
          if (input.modelStep === "supervisor.response" && input.format)
            return {
              text: JSON.stringify({ memoryCandidates: [rejectedMemory] }),
              meta: {},
            };
          return {
            text:
              input.modelStep === "execution.response"
                ? JSON.stringify({
                    finalResponse: "",
                    memoryCandidates: [rejectedMemory],
                  })
                : "",
            meta: {},
          };
        });
        const sessionStore = createInMemorySessionStore();
        await sessionStore.getOrCreateSession("invalid-lifecycle-session");
        await sessionStore.updateSessionTitle(
          "invalid-lifecycle-session",
          "Existing session",
        );
        const appendMessage = vi.spyOn(sessionStore, "appendMessage");
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
            requestId: "invalid-lifecycle-request",
            sessionId: "invalid-lifecycle-session",
            input: "Finish the work and describe only established results.",
            agentMode: "reasoning",
            modelPreference: { profileId: "invalid-output-test", scope: "all" },
          },
          {
            runtimeConfig,
            sessionStore,
            modelGatewayClient: { invoke, invokeRaw: vi.fn() },
            longTermMemory: memory,
          },
        );

        if (degradedOutcome !== "valid") {
          expect(events.filter(({ type }) => type === "failed")).toHaveLength(
            1,
          );
          expect(events.filter(({ type }) => type === "completed")).toEqual([]);
          expect(
            appendMessage.mock.calls.filter(([, role]) => role === "assistant"),
          ).toEqual([]);
          const session = await sessionStore.getSessionById(
            "invalid-lifecycle-session",
          );
          expect(
            session?.messages.filter(({ role }) => role === "assistant"),
          ).toEqual([]);
          expect(memory.scheduleCandidates).not.toHaveBeenCalled();
          expect(memory.processCandidates).not.toHaveBeenCalled();
          expect(
            invoke.mock.calls.filter(
              ([input]) => input.modelStep === "degraded.finalization",
            ),
          ).toHaveLength(degradedOutcome === "invalid" ? 3 : 1);
          return;
        }

        const expected = `${phrasing.failureNotice}\n\n${phrasing.nextStep}`;
        expect(events.filter(({ type }) => type === "failed")).toEqual([]);
        expect(events.filter(({ type }) => type === "completed")).toEqual([
          expect.objectContaining({
            output: expected,
            requestId: "invalid-lifecycle-request",
          }),
        ]);
        const assistantWrites = appendMessage.mock.calls.filter(
          ([, role]) => role === "assistant",
        );
        expect(assistantWrites).toHaveLength(1);
        expect(assistantWrites[0]![2]).toBe(expected);
        const session = await sessionStore.getSessionById(
          "invalid-lifecycle-session",
        );
        const assistantMessages = session?.messages.filter(
          ({ role }) => role === "assistant",
        );
        expect(assistantMessages).toEqual([
          expect.objectContaining({
            content: expected,
            requestId: "invalid-lifecycle-request",
          }),
        ]);
        expect(assistantMessages?.[0]?.observationMeta).toBeUndefined();
        expect(assistantMessages?.[0]?.observationContent).toBeUndefined();
        expect(memory.scheduleCandidates).not.toHaveBeenCalled();
        expect(memory.processCandidates).not.toHaveBeenCalled();
        expect(
          invoke.mock.calls.filter(
            ([input]) => input.modelStep === "degraded.finalization",
          ),
        ).toHaveLength(1);
        const expectedResponseAttempts = phase === "decision" ? 0 : 3;
        expect(
          invoke.mock.calls.filter(
            ([input]) => input.modelStep === policy.responseStep,
          ),
        ).toHaveLength(expectedResponseAttempts);
      },
    );
  },
);
