import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type WebSocket from "ws";
import type { ChatMessage } from "../../../model-gateway/types.js";
import {
  createRuntimeApplication,
  type RuntimeApplication,
} from "../../composition.js";
import type { RequestExecutionPolicyId } from "../../config/model-execution-policy.js";
import { processDebugLogger } from "../../observability/debug-logger.js";
import type { ModelGatewayClient, RuntimeConfig } from "../../ports.js";
import type { SchedulerRun } from "../../scheduler/contracts.js";
import { directRespondText } from "./supervisor-direct-respond.js";

export type ScheduledModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
export const SCHEDULED_PROMPT =
  "Apply the earlier preference to this scheduled answer.";
export const SCHEDULED_ANSWER =
  "The scheduled answer preserves the earlier preference.";

export function createSchedulerTestGate() {
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waiting, open };
}

export async function createSchedulerRuntimeFixture(
  policy: RequestExecutionPolicyId = "supervisor-worker-v1",
  beforeModel?: (input: ScheduledModelInput) => Promise<void>,
) {
  const rootDir = await mkdtemp(
    join(tmpdir(), "scheduler-runtime-integration-"),
  );
  const configPath = join(rootDir, "request-runner.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 2,
      models: { defaults: { profileId: "scheduled-model", steps: {} } },
      context: {
        outputReserveTokens: 1000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      stepDefaults: { timeoutMs: 5000 },
      steps: {},
    }),
  );
  const config: RuntimeConfig = {
    runtimeId: "scheduler-integration",
    agentBridgeUrl: "ws://unused",
    modelGatewayUrl: "http://unused",
    requestRunner: { configPath },
    plugins: { enabled: false },
    logging: {
      enabled: false,
      rotation: { maxFileSizeMb: 1, maxFiles: 1, maxAgeDays: 1 },
    },
    paths: {
      rootDir,
      runtimeDir: join(rootDir, "runtime"),
      agentWorkDir: join(rootDir, "work"),
      sessionsDir: join(rootDir, "sessions"),
      attachmentsDir: join(rootDir, "attachments"),
      workspaceDir: join(rootDir, "workspace"),
      sharedDir: join(rootDir, "shared"),
      compiledDir: join(rootDir, "compiled"),
      traceFile: join(rootDir, "trace.jsonl"),
    },
    models: {
      defaults: { profileId: "scheduled-model" },
      providers: { local: { type: "ollama" } },
      profiles: {
        "scheduled-model": {
          provider: "local",
          model: "scripted",
          contextWindowTokens: 64000,
        },
      },
    },
    modelExecutionPolicies: { "scheduled-model": { policy } },
  };
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    await beforeModel?.(input);
    if (input.modelStep === "supervisor.decision")
      return {
        text: directRespondText("I will apply the conversation preference."),
        meta: {},
      };
    if (input.modelStep === "execution.decision")
      return {
        text: JSON.stringify({
          decision: {
            action: "respond",
            acknowledgement: "I will apply the conversation preference.",
          },
        }),
        meta: {},
      };
    if (
      input.modelStep === "supervisor.response" ||
      input.modelStep === "execution.response"
    ) {
      return { text: SCHEDULED_ANSWER, meta: {} };
    }
    throw new Error(
      `unexpected_scripted_model_step:${String(input.modelStep)}`,
    );
  });
  const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>(async () => {
    throw new Error("unexpected_raw_model_call");
  });
  const events: Record<string, unknown>[] = [];
  let application: RuntimeApplication | undefined;
  try {
    application = createRuntimeApplication(config, {
      models: { invoke, invokeRaw },
    });
    application.subscribeScheduledEvents((event) => events.push(event));
    await application.start();
    await application.services.sessions.appendMessage(
      "session",
      "user",
      "Earlier preference: use brief answers.",
    );
    await application.services.sessions.appendMessage(
      "session",
      "assistant",
      "I will keep the answer brief.",
    );
    await application.services.sessions.updateSessionTitle(
      "session",
      "Established conversation",
    );
  } catch (error) {
    await application?.stop();
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
  const runtime = application;
  const scheduler = application.services.scheduler!;

  return {
    application,
    config,
    rootDir,
    scheduler,
    invoke,
    invokeRaw,
    events,
    async createJob() {
      return scheduler.create({
        sessionId: "session",
        title: "Scheduled answer",
        prompt: SCHEDULED_PROMPT,
        modelProfileId: "scheduled-model",
        agentMode: "deep",
        timeZone: "Asia/Jerusalem",
        schedule: { kind: "timer", delayMs: 3_600_000 },
      });
    },
    async waitForRun(runId: string): Promise<SchedulerRun> {
      let settled: SchedulerRun | undefined;
      await vi.waitFor(
        async () => {
          const run = (await scheduler.listRuns()).find(
            (candidate) => candidate.id === runId,
          );
          if (!run) throw new Error("run_missing");
          if (run.status === "pending" || run.status === "running")
            throw new Error("run_not_settled");
          settled = run;
        },
        { timeout: 5000, interval: 10 },
      );
      return settled!;
    },
    runOrdinaryRequest(text: string, requestId = "ordinary-request") {
      const ws = { send() {} } as unknown as WebSocket;
      return runtime.requests.handle(ws, {
        type: "run_request",
        requestId,
        sessionId: "session",
        text,
        agentMode: "reasoning",
        modelPreference: { profileId: "scheduled-model", scope: "all" },
        toolPermissionMode: "ask",
      });
    },
    async dispose() {
      await runtime.stop();
      await processDebugLogger.drain();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

export function scheduledModelMessages(
  input: ScheduledModelInput,
): readonly ChatMessage[] {
  return input.messages as readonly ChatMessage[];
}
