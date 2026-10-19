import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import { buildSparkConversationInstructions } from "../context/spark-conversation-policy.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { createRequestWorkerCapabilityProvider } from "../request/worker-capability-composition.js";
import { SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT } from "../orchestration/role-calls/index.js";
import { createTestRequestExecutionScopeWithCapabilities } from "./support/request-execution-scope.js";
import { createTargetHandoffFixture, finalDispatchReport, targetHandoffSeed } from "./support/system-target-handoff-fixture.js";
import { createTargetHandoffScript } from "./support/system-target-handoff-script.js";
import { supervisorFormatName, withSupervisorPreparation } from "./support/supervisor-model-phases.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

test("SPARK presentation stays on the root across Planner, Worker, Reviewer and return", async () => {
  const parent = join(process.cwd(), ".codex/artifacts/spark-companion-runtime-20261001");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "handoff-"));
  try {
    const fixture = createTargetHandoffFixture(root);
    await mkdir(fixture.config.paths.agentWorkDir);
    const script = createTargetHandoffScript(() => {});
    const policy = buildSparkConversationInstructions("spark").join("\n");
    let nextCall = 0;
    const rootPresentationSteps: string[] = [];
    const childSteps: string[] = [];
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
      const call = script[nextCall++];
      expect(input.modelStep).toBe(call?.step);
      const messages = input.messages as readonly { role: string; content: string }[];
      const hasPresentationPolicy = messages.some(({ content }) => content.includes(policy));
      if (hasPresentationPolicy) rootPresentationSteps.push(input.modelStep!);
      const isRootStep = input.modelStep?.startsWith("supervisor.") === true;
      if (!isRootStep) {
        childSteps.push(input.modelStep!);
        expect(hasPresentationPolicy).toBe(false);
      }
      return { text: typeof call!.output === "string" ? call!.output : call!.output(input), meta: {} };
    }));
    const seed = { ...targetHandoffSeed(invoke, "ask"), sessionKind: "spark" as const };
    const registry = await fixture.registry.prepareRequest!();
    const request = createTestRequestExecutionScopeWithCapabilities(seed, (view) => {
      expect(view).not.toHaveProperty("sessionKind");
      return createRequestWorkerCapabilityProvider({ request: view,
        executionPolicyAuthority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
        runtimeConfig: fixture.config, toolRegistryOverride: registry });
    });
    await expect(runRequestRunner(request)).resolves.toEqual({ output: finalDispatchReport });
    expect(nextCall).toBe(script.length);
    const preparation = invoke.mock.calls.filter(([input]) => ["supervisor_presentation", "supervisor_skill_selection"].includes(supervisorFormatName(input) ?? ""));
    expect(preparation.map(([input]) => supervisorFormatName(input))).toEqual(["supervisor_presentation"]);
    for (const [input] of preparation) expect(JSON.stringify(input.messages)).not.toContain(policy);
    expect(rootPresentationSteps).toEqual(["supervisor.decision", "supervisor.decision", "supervisor.decision", "supervisor.response"]);
    expect(childSteps).toEqual(expect.arrayContaining(["planner.decision", "worker.decision", "worker.result", "reviewer.decision", "capability.controls"]));
    expect(fixture.executeHostOperation).toHaveBeenCalledTimes(2);
    expect(seed.toolApprovalController!.requestToolApproval).toHaveBeenCalledTimes(2);
    expect(seed.onAnswerToken).toHaveBeenCalledExactlyOnceWith(finalDispatchReport);
    expect(fixture.run).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});
