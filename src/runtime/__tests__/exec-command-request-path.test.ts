import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type WebSocket from "ws";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { handleRunRequest } from "../request/handler.js";
import { createExecCommandPathFixture } from "./support/exec-command-path-fixture.js";
import {
  createExecRequestScript,
  EXEC_REQUEST_FINAL,
  type ExecRequestPolicy,
} from "./support/exec-command-request-script.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

async function runExecRequest(
  policy: ExecRequestPolicy,
  outsideTarget: boolean,
) {
  const fixture = await createExecCommandPathFixture();
  const project = join(fixture.config.paths.rootDir, "project");
  await mkdir(project);
  await writeFile(join(project, "expected.txt"), "obsolete\nproject-content\n");
  await writeFile(
    fixture.config.requestRunner.configPath!,
    JSON.stringify({
      schemaVersion: 2,
      models: { defaults: { profileId: "scripted", steps: {} } },
      context: {
        outputReserveTokens: 1000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      stepDefaults: { timeoutMs: 5000 },
      steps: {},
    }),
  );
  const config = {
    ...fixture.config,
    plugins: { enabled: false },
    longTermMemory: { enabled: false, emitClientEvents: false },
    models: {
      providers: { local: { type: "ollama" as const } },
      profiles: {
        scripted: {
          provider: "local",
          model: "injected-only",
          contextWindowTokens: 64_000,
        },
      },
    },
    modelExecutionPolicies: { scripted: { policy } },
  };
  const command = outsideTarget
    ? "printf 'external-%s' content > ../external.txt; cat ../external.txt; printf verified > marker.txt"
    : "if command -v printf >/dev/null 2>&1; then sed -i.bak '/obsolete/d' expected.txt && time -p x=1 awk '/project/ {print $0}' expected.txt | sed -n '/project/p' && printf discarded >&/dev/null && printf verified > marker.txt; fi";
  const model = createExecRequestScript(policy, command);
  const sessions = createInMemorySessionStore();
  const sessionId = "exec-path-request";
  await sessions.getOrCreateSession(sessionId, {
    project: { id: "project", name: "Project", directory: project },
  });
  await sessions.updateSessionTitle(sessionId, "Exec verification");
  const events: Record<string, unknown>[] = [];
  const ws = {
    send: (data: string) => events.push(JSON.parse(data)),
  } as unknown as WebSocket;
  await handleRunRequest(
    ws,
    {
      type: "run_request",
      requestId: "exec-path-request",
      sessionId,
      input: "Verify the selected project.",
      agentMode: "reasoning",
      toolPermissionMode: "full_plus",
      modelPreference: { profileId: "scripted", scope: "all" },
    },
    {
      runtimeConfig: config,
      sessionStore: sessions,
      modelGatewayClient: model,
      toolRegistry: fixture.registry,
    },
  );
  return {
    ...fixture,
    events,
    model,
    project,
    session: await sessions.getSessionById(sessionId),
  };
}

const policies = ["execution-agent-v1", "supervisor-worker-v1"] as const;

test.each(policies)(
  "%s executes manifest exec in the captured project and returns its evidence",
  async (policy) => {
    const result = await runExecRequest(policy, false);
    expect(result.events.filter(({ type }) => type === "failed")).toEqual([]);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "completed",
        output: EXEC_REQUEST_FINAL,
      }),
    );
    const tools = result.events.filter(({ name }) => name === "tool.completed");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      tool: "exec",
      ok: true,
      executorRole: policy === "execution-agent-v1" ? "supervisor" : "worker",
    });
    await expect(
      readFile(join(result.project, "marker.txt"), "utf8"),
    ).resolves.toBe("verified");
    await expect(
      access(join(result.config.paths.agentWorkDir, "marker.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(result.project, "expected.txt"), "utf8"),
    ).resolves.toBe("project-content\n");
    const inputs = result.model.invoke.mock.calls.map(([input]) => input);
    const continuation = inputs
      .filter(
        ({ modelStep }) =>
          modelStep === "execution.decision" || modelStep === "worker.decision",
      )
      .at(-1)!;
    expect(JSON.stringify(continuation.messages)).toContain("project-content");
    if (policy === "supervisor-worker-v1") {
      const supervisor = inputs
        .filter(({ modelStep }) => modelStep === "supervisor.decision")
        .at(-1)!;
      expect(JSON.stringify(supervisor.messages)).toContain("work_result_v1");
    }
    expect(result.session?.messages.at(-1)?.content).toBe(EXEC_REQUEST_FINAL);
    expect(result.model.invokeRaw).not.toHaveBeenCalled();
  },
);

test.each(policies)(
  "%s executes an external fixture target and continues with its evidence",
  async (policy) => {
    const result = await runExecRequest(policy, true);
    const tools = result.events.filter(({ name }) => name === "tool.completed");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      tool: "exec",
      ok: true,
    });
    await expect(
      readFile(join(result.project, "marker.txt"), "utf8"),
    ).resolves.toBe("verified");
    await expect(
      readFile(join(result.config.paths.rootDir, "external.txt"), "utf8"),
    ).resolves.toBe("external-content");
    const continuation = result.model.invoke.mock.calls
      .map(([input]) => input)
      .filter(
        ({ modelStep }) =>
          modelStep === "execution.decision" || modelStep === "worker.decision",
      )
      .at(-1)!;
    expect(JSON.stringify(continuation.messages)).toContain("external-content");
    expect(result.session?.messages.at(-1)?.content).toBe(EXEC_REQUEST_FINAL);
  },
);
