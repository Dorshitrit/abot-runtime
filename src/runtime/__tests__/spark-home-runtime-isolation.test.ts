import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createRuntimeEnvironment } from "../runtime-environment.js";
import { handleRunRequest } from "../request/handler.js";
import { SESSION_MEMORY_COMPACTORS } from "../context/super-compaction/history-routing.js";
import { createRuntimeConfig, disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import { homeReadTool } from "./support/spark-home-generation-fixture.js";

vi.mock("../request/handler.js", () => ({
  handleRunRequest: vi.fn(async () => {}),
  handleRunRequestWithOutcome: vi.fn(async () => {}),
}));

afterEach(async () => { await disposeCompositionFixtures(); vi.clearAllMocks(); });

test("HOME composition is lazy and ordinary requests retain their original handler dependencies and tool catalog", async () => {
  const config = await createRuntimeConfig();
  const models = { invoke: vi.fn(), invokeRaw: vi.fn() };
  const tools = createConfiguredToolRegistry(undefined, [homeReadTool()]);
  const definitions = tools.listDefinitions();
  const invocations = tools.listNormalInvocations?.();
  const appearance = vi.fn(async () => ({ source: "saved_appearance" as const, background: "#123456" }));
  const environment = createRuntimeEnvironment(config, { models, tools, sparkHomeAppearance: appearance });
  const { sparkHome, sparkHomeGeneration } = environment.services;
  if (!sparkHome || !sparkHomeGeneration) throw new Error("HOME services were not composed");

  expect(sparkHomeGeneration.isIdle()).toBe(true);
  await expect(sparkHome.read()).resolves.toMatchObject({ revision: 0, html: null });
  await expect(sparkHomeGeneration.readRun()).resolves.toBeNull();
  await expect(readdir(join(config.paths.runtimeDir, "spark-home"))).rejects.toMatchObject({ code: "ENOENT" });

  const socket = {} as WebSocket;
  const message = { type: "run_request", requestId: "ordinary-development", sessionId: "ordinary-session", text: "Build a small application" };
  await environment.requests.handle(socket, message);
  expect(handleRunRequest).toHaveBeenCalledOnce();
  const [forwardedSocket, forwardedMessage, forwardedOptions] = vi.mocked(handleRunRequest).mock.calls[0];
  expect(forwardedSocket).toBe(socket);
  expect(forwardedMessage).toBe(message);
  const services = environment.services;
  expect(forwardedOptions).toEqual({
    runtimeConfig: config,
    eventSinkFactory: services.events,
    modelGatewayClient: models,
    sessionStore: services.sessions,
    attachmentStore: services.attachments,
    toolRegistry: tools,
    knowledgeSkillStore: services.knowledgeSkillStore,
    informationBasket: services.informationBasket,
    sessionMemoryCompactor: services.sessionMemoryCompactor,
    [SESSION_MEMORY_COMPACTORS]: services[SESSION_MEMORY_COMPACTORS],
    longTermMemory: services.longTermMemory,
  });
  expect(tools.listDefinitions()).toEqual(definitions);
  expect(tools.listNormalInvocations?.()).toEqual(invocations);
  expect(models.invoke).not.toHaveBeenCalled();
  expect(models.invokeRaw).not.toHaveBeenCalled();
  expect(appearance).not.toHaveBeenCalled();
  expect(sparkHomeGeneration.isIdle()).toBe(true);
  await environment.stop();
});
