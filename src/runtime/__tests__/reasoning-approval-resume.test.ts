import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { successResult } from "../../plugin-sdk/index.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { isRegisteredModelStepInLane } from "../../shared/model-step-registry.js";
import type { SessionRecord } from "../../sessions/types.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createLocalRuntimeOwner } from "../local-host/app-owner.js";
import type { LocalRuntimeOwner } from "../local-host/contracts.js";
import type { LocalPendingToolApproval } from "../local-host/request-approval-contracts.js";
import type { RuntimeConfig } from "../ports.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createExecApprovalScript } from "./support/exec-sensitive-approval-script.js";
import { makeOwnerControlPeer } from "./support/local-runtime-owner-peer.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  resetDebugLoggerConfig();
});

async function fixture(policy: "execution-agent-v1" | "supervisor-worker-v1") {
  const artifacts = join(process.cwd(), ".codex", "artifacts", "llamacpp-reasoning-lifecycle");
  await mkdir(artifacts, { recursive: true });
  const rootDir = await mkdtemp(join(artifacts, "approval-"));
  cleanup.push(() => rm(rootDir, { recursive: true, force: true }));
  const configPath = join(rootDir, "runner.json");
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 2, models: { defaults: { profileId: "gemma", steps: {} } },
    context: { outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
    stepDefaults: { timeoutMs: 5000 }, steps: {},
  }));
  const config: RuntimeConfig = {
    runtimeId: "reasoning-lifecycle", agentBridgeUrl: "ws://unused", modelGatewayUrl: "http://unused",
    requestRunner: { configPath }, plugins: { enabled: false },
    logging: { enabled: false, rotation: { maxFileSizeMb: 1, maxFiles: 1, maxAgeDays: 1 } },
    paths: {
      rootDir, runtimeDir: join(rootDir, "runtime"), agentWorkDir: join(rootDir, "work"),
      sessionsDir: join(rootDir, "sessions"), attachmentsDir: join(rootDir, "attachments"),
      workspaceDir: join(rootDir, "workspace"), sharedDir: join(rootDir, "shared"),
      compiledDir: join(rootDir, "compiled"), traceFile: join(rootDir, "trace.jsonl"),
    },
    models: {
      providers: { native: { type: "llamacpp", baseUrl: "http://unused.invalid:8080" } },
      profiles: { gemma: { provider: "native", model: "fixture", contextWindowTokens: 64000,
        supportsThinking: true, generation: { reasoningEffort: "none" } } },
      invocationProfiles: { alias: { profileId: "gemma" } },
      defaults: { profileId: "gemma" },
    },
    modelExecutionPolicies: { gemma: { policy } },
  };
  const models = createExecApprovalScript(policy, [{ capabilityId: "record_effect", controls: {} }], "approval_fixture");
  const execute = vi.fn(async () => successResult({ output: "The approved fixture action completed." }));
  const module: ToolModuleDeclaration = {
    definition: { name: "reasoning_approval", routingCapability: "semantic_mutation", catalogGroups: ["approval_fixture"] },
    normalInvocation: { version: 1, operations: [{
      operationId: "record_effect", summary: "Record one fixture effect.", effect: "mutating", approval: "request_policy",
      input: { type: "object", additionalProperties: false, properties: {}, required: [] },
    }] },
    implementation: execute,
  };
  const peer = makeOwnerControlPeer("reasoning-test-view").peer;
  const start = async () => {
    const owner = await createLocalRuntimeOwner(config, {
      models, tools: createConfiguredToolRegistry(config, [module]),
    });
    cleanup.push(async () => { await owner.stop(); await owner.whenIdle?.(); });
    return owner;
  };
  const owner = await start();
  await owner.call("sessions.getOrCreateSession", ["session"], peer);
  await owner.call("sessions.updateSessionTitle", ["session", "Existing conversation"], peer);
  return { config, models, execute, peer, owner, start };
}

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s persists profile-bound reasoning through a saved approval and owner restart",
  async (policy) => {
    const f = await fixture(policy);
    const preference = { profileId: "gemma", mode: "budget", budgetTokens: 128 };
    const outcome = await f.owner.call("request.run", [{
      type: "run_request", requestId: "budget-request", sessionId: "session",
      text: "Perform one fixture action.", toolPermissionMode: "ask", agentMode: "fast",
      modelPreference: { profileId: "alias", scope: "all" }, reasoningPreference: preference,
    }, { durableApprovals: true, approvalAvailable: true }], f.peer);
    expect(outcome).toMatchObject({ kind: "awaiting_approval" });
    expect(f.execute).not.toHaveBeenCalled();
    const pending = await f.owner.call("request.approvals", ["session"], f.peer) as LocalPendingToolApproval[];
    expect(pending).toHaveLength(1);
    const sessionFile = JSON.parse(await readFile(join(f.config.paths.sessionsDir, "session.json"), "utf8"));
    const reference = sessionFile.requests.find((request: { requestId: string }) => request.requestId === "budget-request").lifecycle.wait.continuation;
    const saved = JSON.parse(await readFile(join(f.config.paths.sessionsDir, ".request-continuations", "session", reference.blob.sha256 + ".blob"), "utf8"));
    expect(saved.seed.reasoningPreference).toEqual(preference);
    const callCountBeforeRestart = f.models.invoke.mock.calls.length;
    preference.budgetTokens = 999; // A later client edit cannot mutate an admitted wait.
    await f.owner.stop();
    await f.owner.whenIdle?.();
    f.config.models!.profiles!.gemma!.generation = { reasoningBudget: { mode: "tokens", tokens: 900 } };
    const restarted = await f.start();
    expect(await restarted.call("request.approvals", ["session"], f.peer)).toEqual(pending);
    expect(f.models.invoke).toHaveBeenCalledTimes(callCountBeforeRestart);
    const approval = pending[0]!;
    const receipt = await restarted.call("request.approval.decide", [{
      sessionId: "session", requestId: "budget-request", approvalId: approval.request.approvalId,
      ...approval.wait!, commandId: "approve-original", approved: true,
    }], f.peer);
    expect(receipt).toEqual({ accepted: true });
    await restarted.whenIdle?.();
    await expectCompleted(restarted, f.peer);
    expect(f.execute).toHaveBeenCalledOnce();
    const resumed = f.models.invoke.mock.calls.slice(callCountBeforeRestart).map(([input]) => input);
    expect(resumed.some((input) => isRegisteredModelStepInLane(input.modelStep, "main"))).toBe(true);
    for (const input of resumed) {
      expect(input.reasoningPreference).toEqual({ profileId: "gemma", mode: "budget", budgetTokens: 128 });
      const resolved = resolveModelInvocation(input);
      if (isRegisteredModelStepInLane(input.modelStep, "main")) {
        expect(resolved.reasoningBudget).toEqual({ mode: "tokens", tokens: 128 });
      } else {
        expect(resolved).not.toHaveProperty("reasoningBudget");
      }
    }
    expect(f.models.invokeRaw).not.toHaveBeenCalled();
  }, 20000,
);

async function expectCompleted(owner: LocalRuntimeOwner, peer: ReturnType<typeof makeOwnerControlPeer>["peer"]) {
  await vi.waitFor(async () => {
    const session = await owner.call("sessions.getSessionById", ["session"], peer) as SessionRecord;
    expect(session.requests?.find((request) => request.requestId === "budget-request")?.status).toBe("completed");
    expect(session.messages.filter((message) => message.requestId === "budget-request" && message.role === "user")).toHaveLength(1);
  });
}
