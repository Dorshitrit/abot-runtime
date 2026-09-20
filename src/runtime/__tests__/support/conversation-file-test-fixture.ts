import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createInMemorySessionStore } from "../../adapters/in-memory-session-store.js";
import { createRuntimeToolPathResolver } from "../../capabilities/runtime-target-path.js";
import { captureFileOutputRootId } from "../../capabilities/file-output-root-identity.js";
import type { ToolFileOutputReceipt } from "../../../capabilities/file-output-presentation.js";
import type { RuntimePaths } from "../../ports.js";
import type { RuntimeEnvironment } from "../../../web-ui/local-runtime/contracts.js";
import type { RuntimeEnvironmentRegistry } from "../../../web-ui/local-runtime/environment-registry.js";
import type { ConversationNativeOpenOptions } from "../../../web-ui/local-runtime/conversation-file-native-open.js";
import { ConversationFileRoutes } from "../../../web-ui/local-runtime/conversation-file-routes.js";
import { LocalRequestExecution } from "../../../web-ui/local-runtime/request-execution.js";
import { RealtimeClientHub } from "../../../web-ui/local-runtime/realtime-hub.js";

export async function createConversationFileFixture(
  nativeOpen: ConversationNativeOpenOptions = {},
) {
  const artifacts = resolve(".codex/artifacts");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "conversation-file-tests-"));
  const paths: RuntimePaths = {
    rootDir: root,
    runtimeDir: join(root, "runtime"),
    agentWorkDir: join(root, "agent"),
    workspaceDir: join(root, "workspace"),
    sessionsDir: join(root, "sessions"),
    attachmentsDir: join(root, "attachments"),
    sharedDir: join(root, "shared"),
    compiledDir: join(root, "compiled"),
    traceFile: join(root, "trace.jsonl"),
  };
  await Promise.all(
    [paths.agentWorkDir, paths.workspaceDir].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const sessions = createInMemorySessionStore();
  await sessions.startRequestStream("chat", "request");
  const environment = {
    services: { config: { paths }, sessions },
  } as RuntimeEnvironment;
  const environments = new Map([["prod", environment]]);
  const availableIds = new Set(["prod"]);
  const registry: Pick<
    RuntimeEnvironmentRegistry,
    "environmentConfig" | "setupRequirement" | "get"
  > = {
    environmentConfig: () => ({
      defaultEnvironmentId: "prod",
      environments: [...availableIds].map((id) => ({
        id,
        label: id,
        isDefault: id === "prod",
      })),
    }),
    setupRequirement: () => null,
    get: (id: string) => environments.get(id)!,
  };
  const requests = new LocalRequestExecution(new RealtimeClientHub());
  const routes = new ConversationFileRoutes(
    registry,
    requests,
    () => "prod",
    nativeOpen,
  );
  const server = createServer((req, res) => {
    const route = new URL(req.url || "/", "http://localhost").pathname.slice(
      "/web-api/".length,
    );
    void routes
      .handle(route, req, res)
      .then((handled) => {
        if (handled) return;
        res.writeHead(404);
        res.end();
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;

  function receipt(
    logicalPath: string,
    operation: ToolFileOutputReceipt["operation"] = "created",
    location: ToolFileOutputReceipt["location"] = "agent_work",
  ): ToolFileOutputReceipt {
    const target = createRuntimeToolPathResolver(paths).resolve(logicalPath, {
      allowedLocations: [location],
      requirePath: true,
    });
    return {
      version: 1,
      location,
      rootId: captureFileOutputRootId(location, target.rootPath),
      relativePath: target.relativePath,
      logicalPath: target.logicalPath,
      operation,
    };
  }

  function completion(
    fileOutput: unknown,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      type: "event",
      name: "tool.completed",
      requestId: "request",
      executionId: "execution",
      ok: true,
      meta: { fileOutput },
      ...overrides,
    };
  }

  function read(
    overrides: Record<string, string | undefined> = {},
    headers: Record<string, string | undefined> = {},
  ) {
    const params = new URLSearchParams({
      environment: "prod",
      sessionId: "chat",
      requestId: "request",
      executionId: "execution",
    });
    for (const [key, value] of Object.entries(overrides))
      if (value !== undefined) params.set(key, value);
    const requestHeaders = new Headers();
    for (const [key, value] of Object.entries(headers))
      if (value !== undefined) requestHeaders.set(key, value);
    return fetch(origin + "/web-api/chat/files?" + params, {
      headers: requestHeaders,
    });
  }

  return {
    root,
    paths,
    sessions,
    environment,
    environments,
    availableIds,
    requests,
    receipt,
    completion,
    read,
    origin,
    openNative(
      options: {
        query?: Record<string, string | undefined>;
        headers?: Record<string, string | undefined>;
        body?: string;
        method?: string;
      } = {},
    ) {
      const params = new URLSearchParams({
        environment: "prod",
        sessionId: "chat",
        requestId: "request",
        executionId: "execution",
      });
      for (const [key, value] of Object.entries(options.query ?? {}))
        if (value !== undefined) params.set(key, value);
      const headers = new Headers({
        origin,
        "content-type": "application/json",
      });
      for (const [key, value] of Object.entries(options.headers ?? {}))
        if (value !== undefined) headers.set(key, value);
      return fetch(origin + "/web-api/chat/files/open?" + params, {
        method: options.method ?? "POST",
        headers,
        ...((options.method ?? "POST") === "GET"
          ? {}
          : { body: options.body ?? "{}" }),
      });
    },
    async record(fileOutput: unknown, overrides: Record<string, unknown> = {}) {
      await sessions.appendRequestEvent(
        "chat",
        "request",
        completion(fileOutput, overrides),
      );
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

export type ConversationFileFixture = Awaited<
  ReturnType<typeof createConversationFileFixture>
>;
