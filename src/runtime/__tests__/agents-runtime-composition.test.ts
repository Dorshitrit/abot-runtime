import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AgentDefinition } from "../agents/agent-records.js";
import type { RuntimeEnvironmentServices } from "../composition.js";
import type { RuntimeConfig } from "../ports.js";
import type { RunRequestMessage } from "../request/contracts.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import {
  createRuntimeEnvironment, rebindRuntimeEnvironmentEvents, recomposeRuntimeEnvironment,
} from "../runtime-environment.js";
import {
  createRuntimeConfig, disposeCompositionFixtures,
} from "./support/runtime-composition-fixture.js";

const environments: ReturnType<typeof createRuntimeEnvironment>[] = [];
const recomposed: RuntimeEnvironmentServices[] = [];
type UnusedModelClient = {
  invoke: Mock<() => Promise<never>>;
  invokeRaw: Mock<() => Promise<never>>;
};
const modelClients: UnusedModelClient[] = [];

function createUnusedModelClient(): UnusedModelClient {
  const client = {
    invoke: vi.fn(async () => { throw new Error("Unexpected model invocation"); }),
    invokeRaw: vi.fn(async () => { throw new Error("Unexpected raw model invocation"); }),
  };
  modelClients.push(client);
  return client;
}

afterEach(async () => {
  try {
    await Promise.all(environments.splice(0).map((environment) => environment.stop()));
    await Promise.all(recomposed.splice(0).map(async (services) => {
      await Promise.all([
        services.stopScheduler?.(), services.passiveLearning?.stop(),
        services.informationBasket?.stop(), services.sparkHomeGeneration?.stop(),
        services.longTermMemory.retention?.stop(),
      ]);
    }));
    for (const models of modelClients.splice(0)) {
      expect(models.invoke).not.toHaveBeenCalled();
      expect(models.invokeRaw).not.toHaveBeenCalled();
    }
  } finally {
    await disposeCompositionFixtures();
  }
});

async function configuration(): Promise<RuntimeConfig> {
  const config = await createRuntimeConfig();
  config.models = {
    profiles: {
      "fixture-super": { model: "fictional-super", contextWindowTokens: 32_768 },
      "fixture-ea": { model: "fictional-ea", contextWindowTokens: 32_768 },
    },
    defaults: { profileId: "fixture-super" },
  };
  config.modelExecutionPolicies = {
    "fixture-super": { policy: "supervisor-worker-v1" },
    "fixture-ea": { policy: "execution-agent-v1" },
  };
  return config;
}

function definition(): Omit<AgentDefinition, "executionPolicy"> {
  return {
    name: "Research", icon: "pebbles-blue", basePrompt: "Find evidence for the assigned objective.",
    modelProfileId: "fixture-super", toolPermissionMode: "ask",
  };
}

function environment(config: RuntimeConfig) {
  const result = createRuntimeEnvironment(config, {
    models: createUnusedModelClient(), sessions: createInMemorySessionStore(),
  });
  environments.push(result);
  return result;
}

function rememberRecomposition(services: RuntimeEnvironmentServices) {
  recomposed.push(services);
  return services;
}

describe("Agent management runtime composition", () => {
  it("constructs lazily and persists only when management is explicitly used", async () => {
    const config = await configuration();
    const directory = join(config.paths.runtimeDir, "agents");
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    const composed = environment(config);
    expect(composed.services.agents).toBeDefined();
    expect(composed.services.agentController).toBeDefined();
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    const saved = await composed.services.agents!.register(definition(), 0);
    expect(saved.agents).toHaveLength(1);
    expect((await composed.services.agentController!.read()).agents[0]?.id).toBe(saved.agents[0]?.id);
    expect(saved.agents[0]?.definition.executionPolicy).toBe("supervisor-worker-v1");
    expect(JSON.parse(await readFile(join(directory, "state.json"), "utf8")))
      .toMatchObject({ revision: saved.revision, agents: [{ id: saved.agents[0]?.id }] });
  });

  it("reloads one durable registry from a second environment instance", async () => {
    const config = await configuration();
    const first = environment(config);
    const saved = await first.services.agents!.register(definition(), 0);
    const second = environment(config);
    expect(second.services.agents).not.toBe(first.services.agents);
    expect(await second.services.agents!.read()).toEqual(saved);
    const revised = await second.services.agents!.update(saved.agents[0]!.id, {
      ...definition(), name: "Verifier", modelProfileId: "fixture-ea",
    }, saved.revision);
    expect(revised.agents[0]?.definition.executionPolicy).toBe("execution-agent-v1");
    expect(await first.services.agents!.read()).toEqual(revised);
  });

  it("retains the exact management service when only the event sink is rebound", async () => {
    const composed = environment(await configuration());
    const rebound = rebindRuntimeEnvironmentEvents(composed.services, { ...composed.services.events });
    expect(rebound).toBeDefined();
    expect(rebound).not.toBe(composed.services);
    expect(rebound!.agents).toBe(composed.services.agents);
    expect(rebound!.agentController).toBe(composed.services.agentController);
    const saved = await rebound!.agents!.register(definition(), 0);
    expect(await composed.services.agents!.read()).toEqual(saved);
  });

  it("isolates management storage when recomposed with another runtime directory", async () => {
    const config = await configuration();
    const original = environment(config);
    const saved = await original.services.agents!.register(definition(), 0);
    const otherConfig = await configuration();
    otherConfig.runtimeId = "isolated-environment";
    const isolated = rememberRecomposition(recomposeRuntimeEnvironment(otherConfig, original.services, {
      models: createUnusedModelClient(), sessions: createInMemorySessionStore(),
    }));
    expect(isolated.agents).not.toBe(original.services.agents);
    expect(isolated.agentController).not.toBe(original.services.agentController);
    expect(await isolated.agents!.read()).toEqual({ revision: 0, agents: [] });
    await isolated.agents!.register({ ...definition(), name: "Isolated" }, 0);
    expect(await original.services.agents!.read()).toEqual(saved);
  });

  it("projects policy drift after recomposition without rewriting stored definitions", async () => {
    const config = await configuration();
    const original = environment(config);
    const saved = await original.services.agents!.register(definition(), 0);
    const filename = join(config.paths.runtimeDir, "agents", "state.json");
    const bytes = await readFile(filename, "utf8");
    const changedConfig: RuntimeConfig = {
      ...config,
      modelExecutionPolicies: {
        ...config.modelExecutionPolicies,
        "fixture-super": { policy: "execution-agent-v1" },
      },
    };
    const changed = rememberRecomposition(recomposeRuntimeEnvironment(changedConfig, original.services, {
      models: createUnusedModelClient(), sessions: createInMemorySessionStore(),
    }));
    const projected = await changed.agents!.read();
    expect(projected.revision).toBe(saved.revision);
    expect(projected.agents[0]?.definition).toEqual(saved.agents[0]?.definition);
    expect(projected.agents[0]?.modelBinding).toEqual({
      status: "unavailable", reason: "execution_policy_changed",
    });
    expect((await original.services.agents!.read()).agents[0]?.modelBinding.status).toBe("configured");
    expect(await readFile(filename, "utf8")).toBe(bytes);
  });

  it("leaves ordinary Chat history and session admission independent of management", async () => {
    const composed = environment(await configuration());
    const request = {
      type: "run_request", requestId: "ordinary-request", sessionId: "ordinary-chat",
      text: "A plain Chat message", modelPreference: { profileId: "fixture-super" },
      toolPermissionMode: "ask",
    } satisfies RunRequestMessage;
    await composed.services.sessions.appendMessage(request.sessionId, "user", request.text);
    await composed.services.sessions.appendMessage(request.sessionId, "assistant", "A plain Chat response");
    const before = await composed.services.sessions.getSessionById(request.sessionId);
    const saved = await composed.services.agents!.register(definition(), 0);
    const archived = await composed.services.agents!.archive(saved.agents[0]!.id, saved.revision);
    await composed.services.agents!.restore(saved.agents[0]!.id, archived.revision);
    expect(await composed.services.sessions.getSessionById(request.sessionId)).toEqual(before);
    expect(await composed.services.sessions.getAllSessions()).toHaveLength(1);
    expect(composed.services.requestAdmission?.isIdle()).toBe(true);
  });
});
