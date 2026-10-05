import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createAutomationPersistence } from "../automations/persistence.js";
import { createAutomationResultStore } from "../automations/result-store.js";
import { createAutomationNodeTransactions } from "../automations/node-transactions.js";
import { createAutomationStepRunner } from "../automations/step-runner.js";
import { createAutomationAgentStepExecutor } from "../automations/agent-step-executor.js";
import { createAutomationReportService } from "../automations/run-report.js";
import { createAutomationToolLifetimes } from "../automations/tool-lifetimes.js";
import { createAutomationModelCapacity } from "../automations/model-capacity.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { DEFAULT_AUTOMATION_LIMITS } from "../automations/limits.js";
import type { AgentNode, AutomationRevision } from "../automations/definition-contracts.js";
import type { AutomationGrantRecord, AutomationResultRecord } from "../automations/storage-records.js";
import { createFileAttachmentStore } from "../attachments/store.js";
import { handleRunRequestWithOutcome } from "../request/handler.js";
import { withAutomationAgentSession } from "../automations/agent-session-lifetime.js";
import type { RuntimeConfig, SessionStore, ModelGatewayClient } from "../ports.js";
import type { SchedulerAutomationRun } from "../scheduler/contracts.js";
import { operation, probeTools } from "./support/automation-agent-tool-fixture.js";

const faults = vi.hoisted(() => ({ directory: "", mode: "", visible: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        if (faults.visible && String(args[0]) === faults.directory)
          throw new Error("injected_manifest_directory_sync_failure");
        await sync();
      });
      return handle;
    }),
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      const manifest = String(args[1]) === join(faults.directory, "scheduler-journal.json");
      if (manifest && faults.mode === "before") throw new Error("injected_manifest_rename_failure");
      await actual.rename(...args);
      if (manifest && faults.mode === "after") faults.visible = true;
    }),
  };
});
// The model/session are scripted; publication, receipts, node transactions and
// the owned filesystem journal are the actual production implementations.
vi.mock("../request/handler.js", () => ({ handleRunRequestWithOutcome: vi.fn() }));
vi.mock("../automations/agent-session-lifetime.js", () => ({ withAutomationAgentSession: vi.fn() }));
vi.mock("../../sessions/record/projection.js", () => ({
  getRequestFinalState: () => ({ status: "completed" }),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  faults.mode = ""; faults.directory = ""; faults.visible = false;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

type Caller = "tool output" | "agent output" | "agent receipt" | "report";
async function fixture(caller: Caller, failure: "before" | "after") {
  const root = await fs.mkdtemp(join(tmpdir(), "automation-result-publication-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const directory = join(root, "scheduler");
  const store = createFileSchedulerStore(directory);
  const release = await store.acquire();
  cleanups.push(release);
  const persistence = createAutomationPersistence(store);
  const results = createAutomationResultStore(root);
  const transactions = createAutomationNodeTransactions({ persistence });
  const tools = probeTools();
  const agent: AgentNode = { kind: "agent", id: "step", title: "Agent", onFailure: "stop",
    modelProfileId: "fixture", agentMode: "fast", roleInstructions: "Observe.",
    prompt: "Return the observation.", inputs: {}, result: { kind: "text" },
    tools: caller === "agent receipt" ? [{ operation, usage: "required" }] : [] };
  const definition: AutomationRevision = { schemaVersion: 1, automationId: "automation", revision: 1,
    title: "Publication", objective: "Preserve output", trigger: { kind: "manual" }, inputs: {},
    limits: DEFAULT_AUTOMATION_LIMITS, body: { kind: "sequence", id: "root", children: [
      caller.startsWith("agent") ? agent : { kind: "tool", id: "step", title: "Observe",
        onFailure: "stop", operation, controls: {} },
    ] } };
  const grant: AutomationGrantRecord = { id: "grant", automationId: "automation", environmentId: "dev",
    grantRevision: 1, mode: "full_access", operations: [operation],
    evidence: { kind: "authenticated_user_action", actionId: "grant", at: new Date().toISOString() } };
  await persistence.update((state) => {
    state.grants.push(grant);
    state.executions.push({ id: "run", automationId: "automation", definitionRevision: 1,
      revision: 1, inputIds: [], nodes: [{ nodeId: "step", status: "running" }] });
  });
  const config = { runtimeId: "dev", agentBridgeUrl: "ws://unused", modelGatewayUrl: "http://unused",
    requestRunner: { configPath: join(root, "request-runner.json") },
    paths: { rootDir: root, agentWorkDir: root, runtimeDir: root,
      sessionsDir: join(root, "sessions"), attachmentsDir: join(root, "attachments"),
      workspaceDir: join(root, "workspace"), sharedDir: join(root, "shared"),
      compiledDir: join(root, "compiled"), traceFile: join(root, "trace.jsonl") },
    models: { defaults: { profileId: "fixture" }, providers: { local: { type: "ollama" } },
      profiles: { fixture: { provider: "local", model: "scripted", contextWindowTokens: 64000 } } },
  } as RuntimeConfig;
  const attachments = createFileAttachmentStore({ attachmentsDir: join(root, "attachments") });
  const lifetimes = createAutomationToolLifetimes();
  const common = { config, definition, persistence, results, transactions, tools: tools.registry,
    attachments, toolLifetimes: lifetimes, runId: "run", automationId: "automation",
    grants: { get: async () => grant } };
  let requestId = "";
  const sessions = { updateSessionTitle: async () => undefined,
    getSessionById: async () => ({ requests: [{ requestId }],
      messages: [{ role: "assistant", requestId, content: "Saved agent output." }] }),
  } as unknown as SessionStore;
  vi.mocked(withAutomationAgentSession).mockImplementation(async (_input, execute) => execute(sessions));
  vi.mocked(handleRunRequestWithOutcome).mockImplementation(async (_ws, request, dependencies) => {
    requestId = request.requestId;
    if (caller === "agent receipt") {
      const effect = { executionId: "effect", actionFingerprint: "fingerprint",
        source: operation, target: operation, effect: "read_only" as const };
      await dependencies!.effectPersistence!.beforeEffect(effect);
      await dependencies!.effectPersistence!.afterEffect({ executionId: "effect",
        outcome: { status: "executed", effect: "read_only", completionActions: [],
          result: { ok: true, tool: operation.toolName, output: "Saved effect receipt.",
            producedNewInformation: true } } });
    }
    return undefined;
  });
  const compiled = compileAutomationGraph(definition);
  if (!compiled.ok) throw new Error("invalid_fixture_graph");
  let record: AutomationResultRecord | undefined;
  const save = results.save;
  vi.spyOn(results, "save").mockImplementation(async (input) => {
    record = await save(input);
    faults.directory = directory; faults.mode = failure;
    return record;
  });
  const invoke = () => {
    if (caller === "report") return createAutomationReportService(common).create({ definition,
      run: { id: "run", startedAt: new Date().toISOString() } as SchedulerAutomationRun, outcome: "succeeded" });
    if (caller.startsWith("agent")) return createAutomationAgentStepExecutor({ ...common, sessions,
      models: {} as ModelGatewayClient, modelCapacity: createAutomationModelCapacity() }).execute({
      node: agent, inputs: {}, sourceAttachments: [], signal: new AbortController().signal });
    return createAutomationStepRunner({ ...common, graph: compiled.graph }).run(
      compiled.graph.steps[0]!, new AbortController().signal);
  };
  return { root, store, release, persistence, results, invoke, saved: () => record! };
}

for (const caller of ["tool output", "agent output", "agent receipt", "report"] as const) {
  test.each(["before", "after"] as const)(`${caller}: %s manifest publication keeps cleanup consistent with recovered head`, async (failure) => {
    const f = await fixture(caller, failure);
    await expect(f.invoke()).rejects.toThrow(failure === "after" ? "directory_sync" : "manifest_rename");
    const record = f.saved();
    expect(record).toBeDefined();
    if (failure === "after") {
      await expect(f.persistence.read()).rejects.toThrow("directory_sync");
      await expect(f.results.read(record)).resolves.toBeDefined();
      await expect(f.results.reconcileUncommitted(f.persistence)).rejects.toThrow("directory_sync");
      await expect(f.results.read(record)).resolves.toBeDefined();
    } else {
      expect((await f.persistence.read()).results).toEqual([]);
      await expect(f.results.read(record)).rejects.toMatchObject({ code: "ENOENT" });
    }
    faults.mode = ""; faults.visible = false;
    await f.release();
    const recovered = createFileSchedulerStore(join(f.root, "scheduler"));
    cleanups.push(await recovered.acquire());
    const durable = createAutomationPersistence(recovered);
    const restartResults = createAutomationResultStore(f.root);
    await restartResults.reconcileUncommitted(durable);
    const state = await durable.read();
    if (failure === "before") { expect(state.results).toEqual([]); return; }
    expect(state.results).toEqual([record]);
    await expect(restartResults.read(state.results[0]!)).resolves.toBeDefined();
    if (caller === "agent receipt") expect(state.attempts[0]?.settlementRef).toBe(record.id);
    if (caller.endsWith("output")) expect(state.executions[0]?.nodes[0]?.resultRef).toBe(record.id);
    // The original store also released its failed publication lifetime. A
    // subsequent durable removal must not leave this ID active forever.
    await durable.update((current) => { current.results = []; });
    await f.results.reconcileUncommitted(durable);
    await expect(restartResults.read(record)).rejects.toMatchObject({ code: "ENOENT" });
  });
}
