import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import type { ModelGatewayClient } from "../ports.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createRuntimeProjectService } from "../projects/service.js";
import { handleRunRequest } from "../request/handler.js";
import { createProjectFixture } from "./support/project-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function createScriptedProjectModel(): ModelGatewayClient {
  const turns = new Map<string, number>();
  return {
    async invoke(input) {
      const requestId = input.debugRequestId!;
      if (input.modelStep === "execution.response")
        return { text: "Saved the requested marker.", meta: {} };
      if (input.modelStep !== "execution.decision")
        throw new Error(`unexpected_project_model_step:${input.modelStep}`);
      const turn = (turns.get(requestId) ?? 0) + 1;
      turns.set(requestId, turn);
      if (turn === 1)
        return {
          text: JSON.stringify({
            decision: {
              action: "open_capability_scope",
              catalogGroupIds: ["files"],
              acknowledgement: "I will save the requested marker.",
              title: "Project marker",
            },
          }),
          meta: {},
        };
      if (turn === 2)
        return {
          text: JSON.stringify({
            decision: {
              action: "invoke_capability",
              capabilityId: "save_marker",
              intent: "Save the marker in the selected working folder.",
              selectionControls: { path: "result.txt", marker: requestId },
              workingDirectory: null,
            },
          }),
          meta: {},
        };
      return {
        text: JSON.stringify({ decision: { action: "respond" } }),
        meta: {},
      };
    },
    async invokeRaw() {
      throw new Error("unexpected_project_raw_model_call");
    },
  };
}

test("real request handler and shared kernel keep concurrent project writes separate from the ordinary root", async () => {
  const fixture = await createProjectFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reachedAdapters: {
    sessionId: string;
    target: string;
    marker: string;
  }[] = [];
  let running: Promise<unknown[]> | undefined;
  try {
    await writeFile(
      fixture.config.requestRunner.configPath,
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
      models: {
        defaults: { profileId: "scripted" },
        providers: { local: { type: "ollama" as const } },
        profiles: {
          scripted: {
            provider: "local",
            model: "injected-only",
            contextWindowTokens: 64000,
          },
        },
      },
      modelExecutionPolicies: {
        scripted: { policy: "execution-agent-v1" as const },
      },
    };
    const sessions = createInMemorySessionStore();
    const projects = createRuntimeProjectService(config, sessions);
    const a = await projects.create({
      name: "A",
      directory: fixture.directories[2]!,
    });
    const b = await projects.create({
      name: "B",
      directory: fixture.directories[3]!,
    });
    const projectSessions = await Promise.all([
      projects.createSession(a.id),
      projects.createSession(b.id),
    ]);
    await sessions.getOrCreateSession("ordinary");
    const requests = [
      {
        sessionId: projectSessions[0]!.sessionId,
        requestId: "project-a-request",
        directory: a.directory,
      },
      {
        sessionId: projectSessions[1]!.sessionId,
        requestId: "project-b-request",
        directory: b.directory,
      },
      {
        sessionId: "ordinary",
        requestId: "ordinary-request",
        directory: config.paths.agentWorkDir,
      },
    ];
    const module: ToolModuleDeclaration = {
      definition: {
        name: "save_marker",
        routingCapability: "filesystem_mutation",
        catalogGroups: ["files"],
        controlsRefinement: "mechanical_when_complete",
        runtimePathBindings: [
          {
            operationId: "save_marker",
            param: "path",
            base: "worker_working_directory",
          },
        ],
      },
      normalInvocation: {
        version: 1,
        operations: [
          {
            operationId: "save_marker",
            summary: "Save one requested marker.",
            effect: "mutating",
            approval: "request_policy",
            selectionControlIds: ["path", "marker"],
            input: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", minLength: 1, maxLength: 4096 },
                marker: { type: "string", minLength: 1, maxLength: 200 },
              },
              required: ["path", "marker"],
            },
          },
        ],
      },
      implementation: async (params, context) => {
        const target = context!.runtimePathResolver!.resolve(
          String(params.path),
          {
            allowedLocations: ["agent_work"],
            requirePath: true,
          },
        );
        reachedAdapters.push({
          sessionId: context!.sharedState!.currentSessionId!,
          target: target.absolutePath,
          marker: String(params.marker),
        });
        await gate;
        await writeFile(target.absolutePath, String(params.marker), {
          flag: "wx",
        });
        return {
          ok: true,
          output: "Marker saved.",
          producedNewInformation: true,
          progress: true,
        };
      },
    };
    const registry = createConfiguredToolRegistry(config, [module]);
    const modelGatewayClient = createScriptedProjectModel();
    const configBefore = JSON.stringify(config);
    const cwdBefore = process.cwd();
    const events: Record<string, unknown>[] = [];
    const ws = {
      send: (data: string) => events.push(JSON.parse(data)),
    } as unknown as WebSocket;
    running = Promise.all(
      requests.map(({ sessionId, requestId }) =>
        handleRunRequest(
          ws,
          {
            type: "run_request",
            sessionId,
            requestId,
            input: "Save this request's marker in result.txt.",
            agentMode: "reasoning",
            toolPermissionMode: "full_access",
            modelPreference: { profileId: "scripted", scope: "all" },
          },
          {
            runtimeConfig: config,
            sessionStore: sessions,
            toolRegistry: registry,
            modelGatewayClient,
          },
        ),
      ),
    );
    try {
      await vi.waitFor(() => expect(reachedAdapters).toHaveLength(3), {
        timeout: 3000,
      });
    } finally {
      release();
    }
    await running;
    for (const request of requests) {
      expect(reachedAdapters).toContainEqual({
        sessionId: request.sessionId,
        target: join(request.directory, "result.txt"),
        marker: request.requestId,
      });
      expect(
        await readFile(join(request.directory, "result.txt"), "utf8"),
      ).toBe(request.requestId);
      expect(
        (await sessions.getSessionById(request.sessionId))?.messages.at(-1),
      ).toMatchObject({ role: "assistant", requestId: request.requestId });
    }
    expect(events.filter((event) => event.type === "failed")).toEqual([]);
    expect(events.filter((event) => event.type === "completed")).toHaveLength(
      3,
    );
    expect(JSON.stringify(config)).toBe(configBefore);
    expect(process.cwd()).toBe(cwdBefore);
  } finally {
    release();
    await running;
    await fixture.close();
  }
}, 15000);
