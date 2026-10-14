import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  buildModelConfig,
  buildProviderConfig,
  DEFAULT_ROOT_RESPONSE_METHODOLOGY_FILES,
  readJsonObject,
  writeJsonObject,
} from "../../../scripts/runtime-setup-files.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { loadRuntimeConfig } from "../config.js";
import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import { createRequestModelPolicy } from "../config/runner/model-policy.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { resolveModelSelection } from "../model/model-selection.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { runRequestRunner } from "../request/runner.js";
import { resolveDirectResponseOffer } from "../steps/execution-agent/direct-response-policy.js";
import {
  createRootInvalidOutputLedger,
  createRootInvalidOutputRequest,
} from "./support/root-invalid-output-fixture.js";

const packageRoot = resolve(import.meta.dirname, "../../..");
let fixtureRoot: string | undefined;

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

test("fresh OpenAI onboarding defaults offer a one-call greeting with response methodologies exactly once", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("The default-onboarding acceptance test must never use the network."),
  );
  fixtureRoot = await mkdtemp(join(tmpdir(), "abot-ea-direct-response-defaults-"));
  const localDir = join(fixtureRoot, "local");
  await mkdir(join(localDir, "models"), { recursive: true });
  await mkdir(join(fixtureRoot, "methodologies"), { recursive: true });

  // CLI and Web UI share these public templates and provider/model builders.
  // Use explicit env:{} below so no real .env or private settings are loaded.
  const runtimeTemplate = await readJsonObject(
    join(packageRoot, "examples/runtime.config.example.json"),
  );
  const modelTemplate = await readJsonObject(
    join(packageRoot, "examples/models/default.config.json"),
  );
  await writeJsonObject(join(localDir, "runtime.config.json"), {
    ...runtimeTemplate,
    models: {
      providers: { openai: buildProviderConfig("openai") },
      profiles: { default: { configRef: "./models/default.config.json" } },
    },
  });
  await writeJsonObject(
    join(localDir, "models/default.config.json"),
    buildModelConfig(modelTemplate, "openai", "public-onboarding-fixture"),
  );
  await copyFile(
    join(packageRoot, "examples/request-runner.config.example.json"),
    join(localDir, "request-runner.config.json"),
  );
  for (const file of DEFAULT_ROOT_RESPONSE_METHODOLOGY_FILES)
    await copyFile(join(packageRoot, file), join(fixtureRoot, file));

  const runtime = loadRuntimeConfig({
    rootDir: fixtureRoot,
    configPath: join(localDir, "runtime.config.json"),
    env: {},
  });
  const runnerConfig = loadRequestRunnerConfig(runtime.requestRunner);
  const modelPolicy = createRequestModelPolicy({
    platformPolicy: runtime.models,
    runnerConfig,
  });
  const selection = resolveModelSelection({
    agentMode: undefined,
    modelPreference: undefined,
    modelPolicy,
    modelExecutionPolicies: runtime.modelExecutionPolicies,
  });
  expect(runtime.longTermMemory).toMatchObject({ enabled: false });
  expect(selection.execution).toEqual({
    policy: "execution-agent-v1",
    primaryProfileId: "default",
    source: "model_profile",
  });
  const memory = createLongTermMemoryService({
    repository: createInMemoryLongTermMemoryRepository(),
    enabled: runtime.longTermMemory!.enabled,
    emitClientEvents: runtime.longTermMemory!.emitClientEvents,
  });
  const methodologies = runnerConfig.steps["execution.response"]!.instructionBlocks!;
  expect(methodologies.map(({ ref }) => ref)).toEqual([
    "../methodologies/response-ux.md",
    "../methodologies/memory-informed-response.md",
  ]);
  expect(runnerConfig.steps["execution.decision"]!.instructionBlocks).toBeUndefined();
  for (const step of ["execution.decision", "execution.response"] as const)
    expect(runnerConfig.steps[step]!.timeoutMs).toBe(90_000);

  const decision = resolveModelInvocation({
    modelStep: "execution.decision", agentMode: selection.agentMode, modelPolicy,
  });
  const response = resolveModelInvocation({
    modelStep: "execution.response", agentMode: selection.agentMode, modelPolicy,
  });
  expect(decision.profile.id).toBe("default");
  expect(response.profile).toEqual(decision.profile);
  expect(response.think).toBe(decision.think);
  expect(response.instructions).toEqual(decision.instructions);
  expect(decision.format).toBe("json");
  expect(response.format).toBeUndefined();

  const answer = "שלום! איך אפשר לעזור?";
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    expect(input.modelStep).toBe("execution.decision");
    validateModelGatewayMessages(input.messages);
    if (!Array.isArray(input.messages)) throw new Error("Expected model messages.");
    const messages = input.messages as readonly ChatMessage[];
    const content = messages.map((message) => message.content).join("\n");
    for (const methodology of methodologies) {
      expect(methodology.content.trim()).not.toBe("");
      expect(content.split(methodology.content)).toHaveLength(2);
    }
    return {
      text: JSON.stringify({
        decision: { action: "respond", acknowledgement: "אענה לברכה.", response: answer },
      }),
      meta: {},
    };
  });
  const request = createRootInvalidOutputRequest(invoke, selection.execution.policy, {
    prompt: "שלום",
    historyMessages: [],
    runnerConfig,
    modelPolicy,
    agentMode: selection.agentMode,
    executionPolicySelection: selection.execution,
    longTermMemory: memory,
  });
  const ledger = await createRootInvalidOutputLedger(selection.execution.policy);
  const head = ledger.current();
  expect(resolveDirectResponseOffer(request, head, head.state.calls[0]!))
    .toMatchObject({ reason: "eligible", maxLength: expect.any(Number) });

  await expect(runRequestRunner(request)).resolves.toMatchObject({
    output: answer,
    outputTextMode: "exact",
  });
  expect(invoke).toHaveBeenCalledOnce();
  expect(request.modelGatewayClient.invokeRaw).not.toHaveBeenCalled();
  expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(answer);
  expect(network).not.toHaveBeenCalled();
});
