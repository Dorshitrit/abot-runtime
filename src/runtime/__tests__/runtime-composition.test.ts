import {
  createRuntimeConfig,
  createEmbeddingModelGatewayClient,
  startCompositionHost,
  disposeCompositionFixtures,
} from "./support/runtime-composition-fixture.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentBridgeOptions } from "../../bridge/start-agent-bridge.js";

const mocks = vi.hoisted(() => ({
  startAgentBridge: vi.fn((_options: AgentBridgeOptions) => ({
    stop: vi.fn(async () => {}),
    getStatus: vi.fn(),
  })),
}));

vi.mock("../../bridge/start-agent-bridge.js", () => ({
  startAgentBridge: mocks.startAgentBridge,
}));

import {
  createDefaultRuntimeHost,
  createDefaultRuntimeDependencies,
  createRuntimeApplication,
  createInMemorySessionStore,
  resetDebugLoggerConfig,
} from "../index.js";
import type { RuntimeConfig, RuntimeEnvironmentServices } from "../index.js";

afterEach(async () => {
  await disposeCompositionFixtures();
  vi.clearAllMocks();
  resetDebugLoggerConfig();
});

describe("runtime composition", () => {
  test("builds default runtime dependencies from one config object", async () => {
    const config = await createRuntimeConfig();
    const runtime = createDefaultRuntimeDependencies(config);

    expect(runtime.config).toBe(config);
    expect(runtime.host.start).toEqual(expect.any(Function));
    expect(runtime.tools.getDefinition("web_fetch")?.name).toBe("web_fetch");
    expect(runtime.tools.getDefinition("web_search")?.name).toBe("web_search");
    await runtime.sessions.appendMessage(
      "composition-session",
      "user",
      "hello",
    );
    const sessionRaw = await readFile(
      join(config.paths.sessionsDir, "composition-session.json"),
      "utf-8",
    );
    expect(JSON.parse(sessionRaw)).toMatchObject({
      id: "composition-session",
      messageCount: 1,
    });

    const sent: Array<Record<string, unknown>> = [];
    const sink = runtime.events.create({
      requestId: "req-composed",
      ws: {
        send: (value: string) => {
          sent.push(JSON.parse(value) as Record<string, unknown>);
        },
      } as never,
    });
    sink.event("planner.plan.created", {
      plan: {
        total: 1,
        completed: 0,
      },
    });

    expect(sent).toHaveLength(1);
    await vi.waitFor(async () => {
      const traceRaw = await readFile(config.paths.traceFile, "utf-8");
      expect(traceRaw).toContain("req-composed");
    });
  });

  test("allows focused dependency overrides while preserving bundled capabilities", async () => {
    const config = await createRuntimeConfig();
    const host = {
      start: () => ({
        stop: async () => {},
      }),
    };

    const runtime = createDefaultRuntimeDependencies(config, { host });

    expect(runtime.host).toBe(host);
    expect(runtime.sessions.getOrCreateSession).toEqual(expect.any(Function));
    expect(runtime.tools.hasToolsAvailable()).toBe(true);
  });

  test("binds one environment service graph to the application host and request handler", async () => {
    const config = await createRuntimeConfig();
    const application = createRuntimeApplication(config);

    expect(application.services.config).toBe(config);
    expect(Object.isFrozen(application)).toBe(true);
    expect(Object.isFrozen(application.services)).toBe(true);
    expect(Object.isFrozen(application.requests)).toBe(true);

    await startCompositionHost(application.host);

    expect(mocks.startAgentBridge).toHaveBeenCalledTimes(1);
    expect(mocks.startAgentBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeConfig: application.services.config,
        eventSinkFactory: application.services.events,
        modelGatewayClient: application.services.models,
        sessionStore: application.services.sessions,
        attachmentStore: application.services.attachments,
        toolRegistry: application.services.tools,
        requestHandler: expect.objectContaining({
          handle: expect.any(Function),
        }),
      }),
    );
  });

  test("preserves backing session storage and other dependency identities through the compatibility facade", async () => {
    const config = await createRuntimeConfig();
    const defaults = createRuntimeApplication(config);
    const host = {
      start: () => ({
        stop: async () => {},
      }),
    };
    const overrides = {
      host,
      sessions: createInMemorySessionStore(),
      attachments: defaults.services.attachments,
      tools: defaults.services.tools,
      models: defaults.services.models,
      events: defaults.services.events,
      sessionMemoryCompactor: defaults.services.sessionMemoryCompactor,
      longTermMemory: defaults.services.longTermMemory,
    };

    const runtime = createDefaultRuntimeDependencies(config, overrides);

    expect(runtime).toEqual({
      config,
      ...overrides,
      sessions: runtime.sessions,
      scheduler: expect.any(Object),
      startScheduler: expect.any(Function),
      stopScheduler: expect.any(Function),
      requestAdmission: expect.any(Object),
    });
    expect(runtime.host).toBe(host);
    // Composition guards the injected backing store so late requests cannot
    // recreate a deleted session; other dependency identities remain unchanged.
    expect(runtime.sessions).not.toBe(overrides.sessions);
    await runtime.sessions.appendMessage(
      "guarded-session",
      "user",
      "backing storage",
    );
    expect(
      (await overrides.sessions.getSessionById("guarded-session"))?.messages[0]
        .content,
    ).toBe("backing storage");
    await runtime.sessions.deleteSession("guarded-session");
    expect(
      await overrides.sessions.getSessionById("guarded-session"),
    ).toBeNull();
    await expect(
      runtime.sessions.appendMessage(
        "guarded-session",
        "assistant",
        "late result",
      ),
    ).rejects.toMatchObject({ code: "session_deleted" });
    await runtime.stopScheduler?.();
    await defaults.stop();
    expect(runtime.attachments).toBe(overrides.attachments);
    expect(runtime.tools).toBe(overrides.tools);
    expect(runtime.models).toBe(overrides.models);
    expect(runtime.events).toBe(overrides.events);
    expect(runtime.sessionMemoryCompactor).toBe(
      overrides.sessionMemoryCompactor,
    );
    expect(runtime.longTermMemory).toBe(overrides.longTermMemory);
  });

  test("keeps legacy host-start overrides authoritative over bound services", async () => {
    const config = await createRuntimeConfig();
    const application = createRuntimeApplication(config);
    const attachmentStore = {
      ...application.services.attachments,
    };
    const reboundHandler = Object.freeze({
      handle: vi.fn(async () => {}),
    });
    const requestHandlerFactory = vi.fn(
      (_services: RuntimeEnvironmentServices) => reboundHandler,
    );
    const host = createDefaultRuntimeHost(config, {
      services: application.services,
      requestHandler: application.requests,
      requestHandlerFactory,
    });

    await startCompositionHost(host, { attachmentStore });

    expect(requestHandlerFactory).toHaveBeenCalledTimes(1);
    expect(requestHandlerFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        sessions: expect.any(Object),
        attachments: attachmentStore,
        tools: expect.any(Object),
        models: application.services.models,
        events: application.services.events,
      }),
    );
    expect(mocks.startAgentBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentStore,
        requestHandler: expect.objectContaining({
          handle: expect.any(Function),
        }),
      }),
    );
  });

  test("rebinds long-term memory to an overridden model gateway client", async () => {
    const config: RuntimeConfig = {
      ...(await createRuntimeConfig()),
      longTermMemory: {
        enabled: true,
        emitClientEvents: false,
        embeddingProfileId: "memory-embedding",
      },
    };
    const boundEmbeddingCalls: string[] = [];
    const overrideEmbeddingCalls: string[] = [];
    const application = createRuntimeApplication(config, {
      models: createEmbeddingModelGatewayClient(
        "bound-model",
        boundEmbeddingCalls,
      ),
    });
    const reboundHandler = Object.freeze({
      handle: vi.fn(async () => {}),
    });
    const requestHandlerFactory = vi.fn(
      (_services: RuntimeEnvironmentServices) => reboundHandler,
    );
    const host = createDefaultRuntimeHost(config, {
      services: application.services,
      requestHandler: application.requests,
      requestHandlerFactory,
    });

    await startCompositionHost(host, {
      modelGatewayClient: createEmbeddingModelGatewayClient(
        "override-model",
        overrideEmbeddingCalls,
      ),
    });

    const reboundServices = requestHandlerFactory.mock.calls[0]?.[0];
    if (!reboundServices) {
      throw new Error("missing rebound environment services");
    }
    expect(reboundServices.longTermMemory).not.toBe(
      application.services.longTermMemory,
    );
    await reboundServices.longTermMemory.create({
      content: "A durable memory.",
      tags: ["fact"],
      source: "management_api",
      context: { abortSignal: new AbortController().signal },
    });
    expect(overrideEmbeddingCalls).toEqual(["A durable memory."]);
    expect(boundEmbeddingCalls).toEqual([]);
  });

  test("rebuilds every unspecified service from an overridden runtime config", async () => {
    const configA = {
      ...(await createRuntimeConfig()),
      runtimeId: "runtime-a",
      agentBridgeUrl: "ws://bridge-a.test",
      agentBridgeToken: "token-a",
    };
    const configB = {
      ...(await createRuntimeConfig()),
      runtimeId: "runtime-b",
      agentBridgeUrl: "ws://bridge-b.test",
      agentBridgeToken: "token-b",
    };
    const applicationA = createRuntimeApplication(configA);
    const reboundHandler = Object.freeze({
      handle: vi.fn(async () => {}),
    });
    const requestHandlerFactory = vi.fn(
      (_services: RuntimeEnvironmentServices) => reboundHandler,
    );
    const host = createDefaultRuntimeHost(configA, {
      services: applicationA.services,
      requestHandler: applicationA.requests,
      requestHandlerFactory,
    });

    await startCompositionHost(host, { runtimeConfig: configB });

    expect(requestHandlerFactory).toHaveBeenCalledTimes(1);
    const servicesB = requestHandlerFactory.mock.calls[0]?.[0];
    if (!servicesB) throw new Error("missing rebound environment services");
    expect(Object.isFrozen(servicesB)).toBe(true);
    expect(servicesB.config).toBe(configB);
    expect(servicesB.sessions).not.toBe(applicationA.services.sessions);
    expect(servicesB.attachments).not.toBe(applicationA.services.attachments);
    expect(servicesB.tools).not.toBe(applicationA.services.tools);
    expect(servicesB.tools.getDefinition("schedules")?.name).toBe("schedules");
    expect(servicesB.models).not.toBe(applicationA.services.models);
    expect(servicesB.events).not.toBe(applicationA.services.events);
    expect(mocks.startAgentBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeConfig: configB,
        runtimeId: "runtime-b",
        url: "ws://bridge-b.test",
        token: "token-b",
        eventSinkFactory: servicesB.events,
        modelGatewayClient: servicesB.models,
        sessionStore: servicesB.sessions,
        attachmentStore: servicesB.attachments,
        toolRegistry: servicesB.tools,
        requestHandler: expect.objectContaining({
          handle: expect.any(Function),
        }),
      }),
    );

    await servicesB.sessions.appendMessage("config-b-session", "user", "B");
    await expect(
      readFile(
        join(configB.paths.sessionsDir, "config-b-session.json"),
        "utf-8",
      ),
    ).resolves.toContain("config-b-session");
    await expect(
      readFile(
        join(configA.paths.sessionsDir, "config-b-session.json"),
        "utf-8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves custom transport defaults when the runtime config identity is unchanged", async () => {
    const config = await createRuntimeConfig();
    const application = createRuntimeApplication(config);
    const host = createDefaultRuntimeHost(config, {
      runtimeId: "custom-runtime-a",
      agentBridgeUrl: "ws://custom-bridge-a.test",
      agentBridgeToken: "custom-token-a",
      services: application.services,
      requestHandler: application.requests,
    });

    await startCompositionHost(host);

    expect(mocks.startAgentBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeConfig: config,
        runtimeId: "custom-runtime-a",
        url: "ws://custom-bridge-a.test",
        token: "custom-token-a",
        requestHandler: expect.objectContaining({
          handle: expect.any(Function),
        }),
      }),
    );
  });

  test("keeps explicit transport identity authoritative across a config override", async () => {
    const configA = await createRuntimeConfig();
    const configB = await createRuntimeConfig();
    const applicationA = createRuntimeApplication(configA);
    const host = createDefaultRuntimeHost(configA, {
      runtimeId: "default-runtime-a",
      agentBridgeUrl: "ws://default-bridge-a.test",
      agentBridgeToken: "default-token-a",
      services: applicationA.services,
      requestHandler: applicationA.requests,
    });

    await startCompositionHost(host, {
      runtimeConfig: configB,
      runtimeId: "explicit-runtime",
      agentBridgeUrl: "ws://explicit-bridge.test",
      agentBridgeToken: "explicit-token",
    });

    expect(mocks.startAgentBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeConfig: configB,
        runtimeId: "explicit-runtime",
        url: "ws://explicit-bridge.test",
        token: "explicit-token",
      }),
    );
  });

  test("reuses the canonical graph when legacy start options repeat its identities", async () => {
    const config = await createRuntimeConfig();
    const application = createRuntimeApplication(config);

    await startCompositionHost(application.host, {
      runtimeConfig: config,
      eventSinkFactory: application.services.events,
      modelGatewayClient: application.services.models,
      sessionStore: application.services.sessions,
      attachmentStore: application.services.attachments,
      toolRegistry: application.services.tools,
    });

    expect(mocks.startAgentBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeConfig: config,
        eventSinkFactory: application.services.events,
        modelGatewayClient: application.services.models,
        sessionStore: application.services.sessions,
        attachmentStore: application.services.attachments,
        toolRegistry: application.services.tools,
        requestHandler: expect.objectContaining({
          handle: expect.any(Function),
        }),
      }),
    );
  });

  test("binds a request handler for standalone default hosts", async () => {
    const config = await createRuntimeConfig();
    const host = createDefaultRuntimeHost(config);

    await startCompositionHost(host);

    const options = mocks.startAgentBridge.mock.calls.at(-1)?.[0] as
      | { toolRegistry?: { getDefinition(name: string): unknown } }
      | undefined;
    expect(options?.toolRegistry?.getDefinition("schedules")).toBeDefined();

    expect(mocks.startAgentBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeConfig: config,
        eventSinkFactory: expect.any(Object),
        modelGatewayClient: expect.any(Object),
        sessionStore: expect.any(Object),
        attachmentStore: expect.any(Object),
        toolRegistry: expect.any(Object),
        requestHandler: expect.objectContaining({
          handle: expect.any(Function),
        }),
      }),
    );
  });
});
