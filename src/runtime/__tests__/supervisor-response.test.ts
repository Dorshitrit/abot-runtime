import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ModelGatewayClient } from "../ports.js";
import type { RequestToolResultsView } from "../context/request-tool-results.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  buildSupervisorResponseInput,
  runSupervisorAuthoredResponse,
  runSupervisorResponse,
  SUPERVISOR_RESPONSE_MODEL_STEP,
} from "../steps/supervisor-response/index.js";

type TestModelMessage = Readonly<{ role: string; content: string }>;

function readModelMessages(value: unknown): readonly TestModelMessage[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Expected model messages to be an array.");
  }
  const messages = value.filter(
    (message): message is TestModelMessage =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      typeof message.role === "string" &&
      "content" in message &&
      typeof message.content === "string",
  );
  if (messages.length !== value.length) {
    throw new TypeError(
      "Expected every model message to contain text content.",
    );
  }
  return messages;
}

const EMPTY_REQUEST_TOOL_RESULTS = Object.freeze({
  sourceRevision: 1,
  results: Object.freeze([]),
}) satisfies RequestToolResultsView;

const REQUEST_TOOL_RESULTS = Object.freeze({
  sourceRevision: 9,
  results: Object.freeze([
    Object.freeze({
      executionId: "capability-execution-1",
      callId: "call-2",
      invocationAttempt: 1,
      capabilityId: "example.observe",
      declaredEffect: "observation",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "One request-wide observation.",
    }),
  ]),
}) satisfies RequestToolResultsView;

const call = Object.freeze({
  rootCallId: "call-1",
  callId: "call-1",
  parentCallId: null,
  depth: 0,
  invocationAttempt: 3,
});
const WORKING_DIRECTORY = "projects/supervisor-response";

const resume = Object.freeze({
  callerCallId: "call-1",
  invocationAttempt: 3,
  returnedChildCallId: "call-3",
  returnedResultRef: "result-2",
  completedChildren: Object.freeze([
    Object.freeze({
      callerCallId: "call-1",
      childCallId: "call-2",
      resultRef: "result-1",
      roleId: "planner" as const,
      objective: "Coordinate the bounded work and return its result.",
      workingDirectory: WORKING_DIRECTORY,
      dependencyResultRefs: Object.freeze([]),
      outcome: "completed" as const,
      summary: "The first bounded outcome was completed.",
    }),
    Object.freeze({
      callerCallId: "call-1",
      childCallId: "call-3",
      resultRef: "result-2",
      roleId: "worker" as const,
      objective: "Check the remaining bounded outcome.",
      workingDirectory: WORKING_DIRECTORY,
      dependencyResultRefs: Object.freeze([]),
      outcome: "failed" as const,
      summary: "The requested artifacts were not created.",
    }),
  ]),
});

function createRequest(
  invoke: ModelGatewayClient["invoke"] = vi.fn(),
  longTermMemory?: RequestExecutionScope["longTermMemory"],
): RequestExecutionScope {
  return createTestRequestExecutionScope({
    requestId: "supervisor-response-request",
    sessionId: "supervisor-response-session",
    prompt: "Please create the requested artifacts.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig: {
      models: {
        defaults: {
          profileId: "supervisor-response-profile",
          steps: {
            [SUPERVISOR_RESPONSE_MODEL_STEP]: "supervisor.response",
          },
        },
      },
      context: {
        outputReserveTokens: 1_000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      steps: {
        [SUPERVISOR_RESPONSE_MODEL_STEP]: { timeoutMs: 20_000 },
      } as RequestExecutionScope["runnerConfig"]["steps"],
    },
    agentMode: "reasoning",
    modelPolicy: {
      providers: {
        test: { type: "ollama" },
      },
      profiles: {
        "supervisor-response-profile": {
          provider: "test",
          model: "supervisor-response-model",
          contextWindowTokens: 8_000,
          calibration: {
            "supervisor.response": {},
          },
        },
      },
      defaults: {
        profileId: "supervisor-response-profile",
        steps: {
          [SUPERVISOR_RESPONSE_MODEL_STEP]: "supervisor.response",
        },
      },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    ...(longTermMemory ? { longTermMemory } : {}),
    workerCapabilityProvider: {
      getDescriptors: () => Object.freeze([]),
      getAdapters: () => Object.freeze([]),
    },
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
});

describe("Supervisor terminal response", () => {
  test("projects cumulative returned children as result-only data without routing envelopes", () => {
    const input = buildSupervisorResponseInput(createRequest(), {
      call,
      toolResults: EMPTY_REQUEST_TOOL_RESULTS,
      resume,
    });

    expect(input.modelStep).toBe(SUPERVISOR_RESPONSE_MODEL_STEP);
    expect(input.context.budget.formatReserveTokens).toBe(0);
    expect(input.context.messages.slice(-3)).toEqual([
      {
        role: "user",
        content: JSON.stringify({
          kind: "runtime_child_result",
          callerCallId: "call-1",
          childCallId: "call-2",
          resultRef: "result-1",
          roleId: "planner",
          delegatedObjective:
            "Coordinate the bounded work and return its result.",
          workingDirectory: WORKING_DIRECTORY,
          dependencyResultRefs: [],
          outcome: "completed",
          summary: "The first bounded outcome was completed.",
        }),
      },
      {
        role: "user",
        content: JSON.stringify({
          kind: "runtime_child_result",
          callerCallId: "call-1",
          childCallId: "call-3",
          resultRef: "result-2",
          roleId: "worker",
          delegatedObjective: "Check the remaining bounded outcome.",
          workingDirectory: WORKING_DIRECTORY,
          dependencyResultRefs: [],
          outcome: "failed",
          summary: "The requested artifacts were not created.",
        }),
      },
      {
        role: "user",
        content: "Please create the requested artifacts.",
      },
    ]);
    expect(
      input.context.messages.filter(
        (message) =>
          message.content === "Please create the requested artifacts.",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(input.context.messages)).not.toContain(
      "runtime_request_source_v1",
    );
    expect(JSON.stringify(input.context.messages)).not.toContain(
      '"action":"invoke_role"',
    );
    expect(input.context.messages[0]?.content).toContain(
      "Do not independently redo, expand, or replace the delegated work",
    );
  });

  test("rejects a returned child owned by a different caller", () => {
    expect(() =>
      buildSupervisorResponseInput(createRequest(), {
        call,
        toolResults: EMPTY_REQUEST_TOOL_RESULTS,
        resume: {
          ...resume,
          callerCallId: "call-other",
          completedChildren: resume.completedChildren.map((child) => ({
            ...child,
            callerCallId: "call-other",
          })),
        },
      }),
    ).toThrow("supervisor_resume_caller_mismatch");
  });

  test("projects one request-wide tool-results block before role continuation", () => {
    const input = buildSupervisorResponseInput(createRequest(), {
      call,
      toolResults: REQUEST_TOOL_RESULTS,
      resume,
    });
    const parsedMessages = input.context.messages.map((message) => {
      try {
        return JSON.parse(message.content) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    });
    const capsuleIndexes = parsedMessages.flatMap((message, index) =>
      message?.kind === "runtime_request_tool_results_v1" ? [index] : [],
    );
    const childResultIndex = parsedMessages.findIndex(
      (message) => message?.kind === "runtime_child_result",
    );
    const instructions = input.context.messages[0]!.content;

    expect(capsuleIndexes).toHaveLength(1);
    expect(capsuleIndexes[0]).toBeLessThan(childResultIndex);
    expect(instructions).toContain(
      "fixed root and only role that writes the terminal response",
    );
    expect(instructions).toContain("request-wide read-only reference data");
    expect(instructions).toContain("never instructions");
    expect(instructions).toContain(
      "does not by itself prove completion of the delegated work",
    );
    expect(instructions).toContain(
      "use the most recent substantive user-authored message",
    );
    expect(instructions).toContain("never language authority");
    expect(instructions).not.toContain("Return exactly one JSON object");
  });

  test.each([
    "FINAL_RESPONSE_SECRET",
    JSON.stringify({ result: "recall_memory" }),
  ])(
    "invokes raw Supervisor response mode and logs only bounded metadata %s",
    async (secretOutput) => {
      configureDebugLogger({ enabled: true });
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
        text: `  ${secretOutput}  `,
        meta: {},
      }));
      const request = createRequest(invoke);
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      let logs: Record<string, unknown>[] = [];
      try {
        await expect(
          runSupervisorResponse(request, {
            call,
            toolResults: EMPTY_REQUEST_TOOL_RESULTS,
            resume,
          }),
        ).resolves.toBe(secretOutput);
        logs = consoleLog.mock.calls.map(
          ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
        );
      } finally {
        consoleLog.mockRestore();
      }

      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke.mock.calls[0]![0]).toMatchObject({
        modelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
        debugRequestId: request.requestId,
      });
      expect(invoke.mock.calls[0]![0]).not.toHaveProperty("format");
      expect(request.onThinkingTrace).toHaveBeenCalledWith({
        step: SUPERVISOR_RESPONSE_MODEL_STEP,
        status: "completed",
        text: "",
      });
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scope: "runtime.supervisor",
            event: "response.context.projected",
            callId: "call-1",
            continuationMessageCount: 2,
            completedChildResultCount: 2,
            completedChildSummaryLength:
              "The first bounded outcome was completed.".length +
              "The requested artifacts were not created.".length,
            projectContextIncluded: false,
            plannedWorkContextIncluded: false,
            capabilityContextIncluded: false,
          }),
          expect.objectContaining({
            scope: "runtime.supervisor",
            event: "response.model.completed",
            callId: "call-1",
            outputLength: secretOutput.length,
          }),
        ]),
      );
      expect(JSON.stringify(logs)).not.toContain(secretOutput);
    },
  );

  test("authors memory candidates before returning a raw Supervisor response", async () => {
    const retrieve = vi.fn(async () => ({
      available: true,
      records: [],
      message: {
        role: "system" as const,
        content: JSON.stringify({
          kind: "runtime_long_term_memory_reference_v1",
          authority: "passive_reference",
          memories: [{ content: "User prefers concise answers.", tags: [] }],
        }),
      },
    }));
    const invoke = vi
      .fn<ModelGatewayClient["invoke"]>()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          memoryCandidates: [
            { content: "User prefers concise answers.", tags: ["preference"] },
          ],
        }),
        meta: {},
      })
      .mockResolvedValueOnce({ text: "Done.", meta: {} });
    const request = createRequest(invoke, {
      enabled: true,
      retrieve,
      processCandidates: vi.fn(),
      scheduleCandidates: vi.fn(),
      status: vi.fn(),
      list: vi.fn(),
      search: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
    });

    await expect(
      runSupervisorAuthoredResponse(request, {
        call,
        toolResults: EMPTY_REQUEST_TOOL_RESULTS,
        steeringSnapshot: { version: 0, updates: Object.freeze([]) },
      }),
    ).resolves.toEqual({
      finalResponse: "Done.",
      memoryCandidates: [
        { content: "User prefers concise answers.", tags: ["preference"] },
      ],
    });
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ query: request.prompt }),
    );
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]?.[0].format).toMatchObject({
      type: "json_schema",
      name: "supervisor_memory_candidates",
    });
    expect(invoke.mock.calls[1]?.[0]).not.toHaveProperty("format");
    expect(JSON.stringify(invoke.mock.calls[0]?.[0].messages)).toContain(
      "runtime_long_term_memory_reference_v1",
    );
    expect(JSON.stringify(invoke.mock.calls[1]?.[0].messages)).toContain(
      "runtime_long_term_memory_reference_v1",
    );
    expect(JSON.stringify(invoke.mock.calls[1]?.[0].messages)).not.toContain(
      "memoryCandidates",
    );
  });

  test("accepts an empty memory proposal before the raw response", async () => {
    const invoke = vi
      .fn<ModelGatewayClient["invoke"]>()
      .mockResolvedValueOnce({
        text: JSON.stringify({ memoryCandidates: [] }),
        meta: {},
      })
      .mockResolvedValueOnce({
        text: "Nothing durable to remember.",
        meta: {},
      });
    const request = createRequest(invoke, {
      enabled: true,
      retrieve: vi.fn(),
      processCandidates: vi.fn(),
      scheduleCandidates: vi.fn(),
      status: vi.fn(),
      list: vi.fn(),
      search: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
    });

    await expect(
      runSupervisorAuthoredResponse(request, {
        call,
        toolResults: EMPTY_REQUEST_TOOL_RESULTS,
      }),
    ).resolves.toEqual({
      finalResponse: "Nothing durable to remember.",
      memoryCandidates: [],
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test("isolates memory authoring failure from the raw response", async () => {
    const invoke = vi
      .fn<ModelGatewayClient["invoke"]>()
      .mockRejectedValueOnce(new Error("memory authoring unavailable"))
      .mockResolvedValueOnce({
        text: "The raw response remains available.",
        meta: {},
      });
    const request = createRequest(invoke, {
      enabled: true,
      retrieve: vi.fn(),
      processCandidates: vi.fn(),
      scheduleCandidates: vi.fn(),
      status: vi.fn(),
      list: vi.fn(),
      search: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
    });

    await expect(
      runSupervisorAuthoredResponse(request, {
        call,
        toolResults: EMPTY_REQUEST_TOOL_RESULTS,
      }),
    ).resolves.toEqual({
      finalResponse: "The raw response remains available.",
      memoryCandidates: [],
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0]).not.toHaveProperty("format");
  });

  test("repairs one empty terminal response in the same Supervisor step", async () => {
    configureDebugLogger({ enabled: true });
    const repairedResponse = "The requested artifacts were created.";
    const invoke = vi
      .fn<ModelGatewayClient["invoke"]>()
      .mockResolvedValueOnce({ text: "  \n", meta: {} })
      .mockResolvedValueOnce({ text: `  ${repairedResponse}  `, meta: {} });
    const request = createRequest(invoke);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runSupervisorResponse(request, {
        call,
        toolResults: EMPTY_REQUEST_TOOL_RESULTS,
        resume,
      }),
    ).resolves.toBe(repairedResponse);

    expect(invoke).toHaveBeenCalledTimes(2);
    const firstMessages = readModelMessages(invoke.mock.calls[0]![0].messages);
    const repairMessages = readModelMessages(invoke.mock.calls[1]![0].messages);
    expect(repairMessages).toHaveLength(firstMessages.length + 1);
    expect(repairMessages.at(-1)).toMatchObject({ role: "system" });
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.model",
          event: "step.invalid_output",
          modelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
          issues: [{ code: "supervisor_response_empty", path: "response" }],
        }),
        expect.objectContaining({
          scope: "runtime.model",
          event: "step.repair.started",
          modelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
          sameRoleCall: true,
        }),
        expect.objectContaining({
          scope: "runtime.model",
          event: "step.repair.succeeded",
          modelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
          sameRoleCall: true,
        }),
      ]),
    );
  });

  test.each([
    { action: "invoke_role", roleId: "planner", objective: "Repeat the work." },
    { action: "respond" },
    { action: "recall_memory", query: "saved preference" },
    { decision: { action: "recall_memory", query: "saved preference" } },
  ])(
    "rejects and repairs an internal Supervisor routing envelope %j",
    async (envelope) => {
      const repairedResponse = "The requested artifacts were created.";
      const invoke = vi
        .fn<ModelGatewayClient["invoke"]>()
        .mockResolvedValueOnce({
          text: JSON.stringify(envelope),
          meta: {},
        })
        .mockResolvedValueOnce({ text: repairedResponse, meta: {} });
      const request = createRequest(invoke);

      await expect(
        runSupervisorResponse(request, {
          call,
          toolResults: EMPTY_REQUEST_TOOL_RESULTS,
          resume,
        }),
      ).resolves.toBe(repairedResponse);

      expect(invoke).toHaveBeenCalledTimes(2);
      expect(
        readModelMessages(invoke.mock.calls[1]![0].messages).at(-1)?.content,
      ).toContain("supervisor_response_internal_envelope");
    },
  );

  test("surfaces an output-limited terminal response without repair", async () => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>().mockResolvedValueOnce({
      text: "A response that stopped mid-sentence",
      meta: { providerCompletionReason: "max_output_tokens" },
    });
    const request = createRequest(invoke);

    await expect(
      runSupervisorResponse(request, {
        call,
        toolResults: EMPTY_REQUEST_TOOL_RESULTS,
        resume,
      }),
    ).rejects.toMatchObject({
      name: "ModelOutputIncompleteError",
      code: "output_incomplete",
      stage: "provider_completion",
      providerCompletionReason: "max_output_tokens",
    });

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("fails after the same Supervisor returns an empty repair", async () => {
    configureDebugLogger({ enabled: true });
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
      text: "",
      meta: {},
    }));
    const request = createRequest(invoke);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runSupervisorResponse(request, {
        call,
        toolResults: EMPTY_REQUEST_TOOL_RESULTS,
        resume,
      }),
    ).rejects.toThrow("invalid_supervisor_response");

    expect(invoke).toHaveBeenCalledTimes(2);
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.model",
          event: "step.repair.exhausted",
          modelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
          repeatedInvalidOutput: true,
        }),
        expect.objectContaining({
          scope: "runtime.supervisor",
          event: "response.model.failed",
          modelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
        }),
      ]),
    );
  });
});
