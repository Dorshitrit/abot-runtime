import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type WebSocket from "ws";
import { createConfiguredSkillProvider } from "../adapters/configured-skill-provider.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { handleRunRequest } from "../request/handler.js";
import { createDevViewLocatorFixture } from "./support/dev-view-locator-fixture.js";
import {
  createDevViewRequestScript,
  DEV_VIEW_REQUEST_FINAL,
} from "./support/dev-view-request-script.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s carries locator guidance and failed candidates into a numeric successor",
  async (policy) => {
    const fixture = await createDevViewLocatorFixture();
    const content = "header\nx target one\nmiddle\ny target two\nfooter";
    const file = join(fixture.config.paths.agentWorkDir, "notes.txt");
    await writeFile(file, content);
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
      plugins: { enabled: true, allow: ["filesystem"] },
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
    const guidance = await createConfiguredSkillProvider({
      config,
      listToolDefinitions: fixture.registry.listDefinitions,
    }).getActionContext("dev_view");
    expect(guidance.length).toBeGreaterThan(0);
    const model = createDevViewRequestScript(policy, guidance);
    const sessions = createInMemorySessionStore();
    const sessionId = "dev-view-request";
    await sessions.getOrCreateSession(sessionId);
    await sessions.updateSessionTitle(sessionId, "Locator verification");
    const events: Record<string, unknown>[] = [];
    const ws = {
      send: (data: string) => events.push(JSON.parse(data)),
    } as unknown as WebSocket;
    await handleRunRequest(
      ws,
      {
        type: "run_request",
        requestId: sessionId,
        sessionId,
        input: "Read the second target section in notes.txt.",
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
    expect(events.filter(({ type }) => type === "failed")).toEqual([]);
    const completedTools = events.filter(
      ({ name }) => name === "tool.completed",
    );
    expect(completedTools).toHaveLength(2);
    expect(completedTools[0]).toMatchObject({
      tool: "dev_view",
      ok: false,
      meta: { errorCode: "ambiguous_text_locator", candidateCount: 2 },
    });
    expect(completedTools[1]).toMatchObject({
      tool: "dev_view",
      ok: true,
      meta: { startLine: 3, endLine: 5 },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "completed",
        output: DEV_VIEW_REQUEST_FINAL,
      }),
    );
    const lastDecision = model.invoke.mock.calls
      .map(([input]) => input)
      .filter(
        ({ modelStep }) =>
          modelStep === "execution.decision" || modelStep === "worker.decision",
      )
      .at(-1)!;
    expect(JSON.stringify(lastDecision.messages)).toContain("y target two");
    expect(await readFile(file, "utf8")).toBe(content);
    expect(
      (await sessions.getSessionById(sessionId))?.messages.at(-1)?.content,
    ).toBe(DEV_VIEW_REQUEST_FINAL);
    expect(model.invokeRaw).not.toHaveBeenCalled();
  },
);
