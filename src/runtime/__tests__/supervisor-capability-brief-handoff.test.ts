import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ChatMessage } from "../../model-gateway/types.js";
import { isCapabilityBriefMessage } from "../context/capability-brief.js";
import { SUPERVISOR_RESPONSE_RECOMMENDATION_KIND } from "../steps/supervisor-response/response-recommendation.js";
import { createDefaultToolRegistry } from "../default-adapters.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT } from "../orchestration/role-calls/index.js";
import type { ModelGatewayClient, RuntimeConfig } from "../ports.js";
import { runRequestRunner } from "../request/runner.js";
import { createRequestWorkerCapabilityProvider } from "../request/worker-capability-composition.js";
import {
  createTestRequestExecutionScopeWithCapabilities,
  type TestRequestSeed,
} from "./support/request-execution-scope.js";

type ModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
type ScriptedCall = Readonly<{
  step: ModelInput["modelStep"];
  format?: string;
  output: string | ((input: ModelInput) => string);
}>;

const artifactPath = "brief-proof.txt";
const artifactBody = "The delegated artifact has exact content.\n";
const userPrompt = `Create ${artifactPath} containing ${JSON.stringify(artifactBody)}.`;
const plannerObjective = "Coordinate creation of the exact requested file.";
const workerObjective = "Write the file specified in the accepted request.";
const workerResult = "Created the requested file with the exact content.";
const plannerResult = "The Worker created the requested file.";
const finalResponse = "The requested file is created and the review returned.";

function encodeDecision(decision: unknown): string {
  return JSON.stringify({ decision });
}

function modelMessages(input: ModelInput): readonly ChatMessage[] {
  return input.messages as readonly ChatMessage[];
}

function readCapsule(input: ModelInput, kind: string): Record<string, unknown> {
  for (const message of [...modelMessages(input)].reverse()) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message.content) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.kind === kind) return parsed;
  }
  throw new Error(`test_capsule_missing:${kind}`);
}

function reviewerOutput(input: ModelInput): string {
  const capsule = readCapsule(input, "runtime_reviewer_audit_v4");
  expect(capsule.dependencySubjects).toEqual([
    expect.objectContaining({
      roleId: "planner",
      objective: plannerObjective,
      outcome: "completed",
    }),
  ]);
  const effects = capsule.effects as readonly {
    evidenceRef: string;
    outcome: string;
    effect: string;
  }[];
  expect(effects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ outcome: "succeeded", effect: "mutation" }),
    ]),
  );
  const auditScope = capsule.auditScope as { reviewScopeId: string };
  return encodeDecision({
    action: "report_gaps",
    reviewScopeId: auditScope.reviewScopeId,
    summary: "The file was created, but independent readback is absent.",
    audit: {
      evidenceAssessments: effects.map(({ evidenceRef }) => ({
        evidenceRef,
        status: "supports",
        finding: "This effect establishes that the write succeeded.",
      })),
      completionAssessment: {
        status: "gap",
        evidenceRefs: effects.map(({ evidenceRef }) => evidenceRef),
        finding: "The supplied evidence has no independent readback.",
      },
    },
    gaps: [
      {
        kind: "missing_evidence",
        subjectRefs: [],
        factRefs: [],
        evidenceRefs: [],
        summary: "Independent readback is not in the supplied evidence.",
      },
    ],
  });
}

function createScript(): readonly ScriptedCall[] {
  return [
    {
      step: "supervisor.decision",
      format: "supervisor_decision",
      output: encodeDecision({
        action: "invoke_role",
        roleId: "planner",
        objective: plannerObjective,
        acknowledgement: "I will create the requested file.",
      }),
    },
    {
      step: "supervisor.decision",
      format: "supervisor_working_directory",
      output: JSON.stringify({ workingDirectory: "." }),
    },
    {
      step: "planner.decision",
      output: encodeDecision({
        action: "invoke_role",
        roleId: "worker",
        plan: {
          summary: plannerObjective,
          items: [{ title: "Create the file", objective: workerObjective }],
        },
        selectedItemIndexes: [0],
        workerCapabilityScope: { catalogGroupIds: ["write"] },
      }),
    },
    {
      step: "worker.decision",
      output: encodeDecision({
        action: "invoke_capability",
        capabilityId: "write_complete_file",
        intent: "Create the requested file.",
        authoringObjective: `Write exactly ${JSON.stringify(artifactBody)}.`,
        selectionControls: { path: artifactPath },
      }),
    },
    { step: "tool_payload.raw", output: artifactBody },
    {
      step: "worker.decision",
      output: encodeDecision({ action: "return_result" }),
    },
    { step: "worker.result", output: workerResult },
    {
      step: "planner.decision",
      output: (input) => {
        expect(readCapsule(input, "runtime_child_result")).toMatchObject({
          callerCallId: "call-2",
          childCallId: "call-3",
          roleId: "worker",
          delegatedObjective: workerObjective,
          summary: workerResult,
          outcome: "completed",
        });
        return encodeDecision({
          action: "return_result",
          result: plannerResult,
        });
      },
    },
    {
      step: "supervisor.decision",
      format: "supervisor_decision",
      output: (input) => {
        expect(readCapsule(input, "runtime_child_result")).toMatchObject({
          callerCallId: "call-1",
          childCallId: "call-2",
          roleId: "planner",
          summary: plannerResult,
          outcome: "completed",
        });
        return encodeDecision({ action: "invoke_role", roleId: "reviewer" });
      },
    },
    { step: "reviewer.decision", output: reviewerOutput },
    {
      step: "supervisor.decision",
      format: "supervisor_decision",
      output: (input) => {
        expect(readCapsule(input, "runtime_child_result")).toMatchObject({
          callerCallId: "call-1",
          roleId: "reviewer",
          outcome: "completed",
          reviewerVerdict: {
            kind: "reviewer_verdict_v1",
            verdict: "report_gaps",
          },
        });
        return encodeDecision({ action: "respond" });
      },
    },
    { step: "supervisor.response", output: finalResponse },
  ];
}

function createRuntimeConfig(hostRoot: string): RuntimeConfig {
  const runtimeDir = join(hostRoot, "runtime");
  return {
    runtimeId: "capability-brief-test",
    agentBridgeUrl: "ws://test",
    modelGatewayUrl: "http://model",
    paths: {
      rootDir: process.cwd(),
      runtimeDir,
      agentWorkDir: join(hostRoot, "agent-work"),
      sessionsDir: join(runtimeDir, "sessions"),
      attachmentsDir: join(runtimeDir, "attachments"),
      workspaceDir: join(runtimeDir, "workspace"),
      sharedDir: join(runtimeDir, "shared"),
      compiledDir: join(runtimeDir, "compiled"),
      traceFile: join(runtimeDir, "trace.jsonl"),
    },
    plugins: { enabled: true, allow: ["filesystem.write_file"] },
    requestRunner: { configPath: join(hostRoot, "request-runner.config.json") },
  };
}

function createSeed(
  invoke: ModelGatewayClient["invoke"],
): Omit<TestRequestSeed, "workerCapabilityProvider"> {
  return {
    requestId: "capability-brief-request",
    sessionId: "capability-brief-session",
    prompt: userPrompt,
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig: {
      models: { defaults: { profileId: "test", steps: {} } },
      context: {
        outputReserveTokens: 1_000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      steps: Object.fromEntries(
        createScript().map(({ step }) => [step, { timeoutMs: 20_000 }]),
      ),
    },
    agentMode: "reasoning",
    modelPolicy: {
      providers: { local: { type: "ollama" } },
      profiles: {
        test: { provider: "local", model: "test", contextWindowTokens: 32_000 },
      },
      defaults: { profileId: "test", steps: {} },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  };
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("Supervisor capability brief handoff", () => {
  test("keeps the request catalog only in routing throughout a real adapter and complete delegated chain", async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), "supervisor-brief-handoff-"));
    const config = createRuntimeConfig(hostRoot);
    await mkdir(config.paths.agentWorkDir);
    const script = createScript();
    let nextCall = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const current = script[nextCall++];
      expect(current, `unexpected model call ${nextCall}`).toBeDefined();
      expect(input.modelStep).toBe(current!.step);
      if (current!.format)
        expect(input.format).toMatchObject({ name: current!.format });
      const briefMessages = modelMessages(input).filter(
        isCapabilityBriefMessage,
      );
      expect(
        modelMessages(input).some(({ content }) =>
          content.includes(SUPERVISOR_RESPONSE_RECOMMENDATION_KIND),
        ),
      ).toBe(false);
      const isSupervisorRouting = current!.format === "supervisor_decision";
      if (isSupervisorRouting) {
        expect(briefMessages).toHaveLength(1);
        expect(briefMessages[0]!.role).toBe("system");
        expect(briefMessages[0]!.content).toContain("write_file");
        expect(briefMessages[0]!.content).toContain("write_complete_file");
        expect(briefMessages[0]!.content).not.toContain("read_file");
        expect(
          modelMessages(input).filter(
            ({ role, content }) => role === "user" && content === userPrompt,
          ),
        ).toHaveLength(1);
      } else {
        expect(briefMessages).toEqual([]);
      }
      const text =
        typeof current!.output === "string"
          ? current!.output
          : current!.output(input);
      return { text, meta: {} };
    });
    const registry = createDefaultToolRegistry(config);
    const execute = vi.spyOn(registry, "execute");
    const request = createTestRequestExecutionScopeWithCapabilities(
      createSeed(invoke),
      (request) =>
        createRequestWorkerCapabilityProvider({
          request,
          executionPolicyAuthority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
          runtimeConfig: config,
          toolRegistryOverride: registry,
        }),
    );

    try {
      await expect(runRequestRunner(request)).resolves.toEqual({
        output: finalResponse,
      });
      expect(nextCall).toBe(script.length);
      for (const [input] of invoke.mock.calls.slice(1)) {
        expect(JSON.stringify(input)).not.toContain("responseRecommendation");
      }
      await expect(
        readFile(join(config.paths.agentWorkDir, artifactPath), "utf8"),
      ).resolves.toBe(artifactBody);
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        {
          tool: "write_file",
          params: { path: artifactPath, content: artifactBody },
        },
        expect.anything(),
      );
      const workerInput = invoke.mock.calls.find(
        ([input]) => input.modelStep === "worker.decision",
      )![0];
      expect(
        readCapsule(workerInput, "runtime_worker_assignment"),
      ).toMatchObject({
        callId: "call-3",
        parentCallId: "call-2",
        objective: workerObjective,
        workingDirectory: ".",
        availableCapabilities: [{ capabilityId: "write_complete_file" }],
      });
      expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        finalResponse,
      );
      expect(request.onEvent).toHaveBeenCalledWith(
        "tool.completed",
        expect.objectContaining({ tool: "write_file", ok: true }),
      );
    } finally {
      await rm(hostRoot, { recursive: true, force: true });
    }
  });
});
