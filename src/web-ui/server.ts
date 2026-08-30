import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";

import { inspectRuntimeConfigFileWithMeta } from "../runtime/config/loader.js";
import type { ModelProviderAdapterRegistry } from "../model-gateway/index.js";
import { loadDotEnvFile } from "../shared/load-dotenv.js";
import { ExternalBridgeWebBackend } from "./external-bridge-backend.js";
import { LocalRuntimeWebBackend } from "./local-runtime-backend.js";
import { resolveWebUiAddress } from "./web-ui-address.js";

const DEFAULT_WEB_BACKEND = "runtime";
const DEFAULT_BRIDGE_API_BASE = "http://127.0.0.1:8787/abot/api";
const DEFAULT_BRIDGE_REALTIME_URL = "ws://127.0.0.1:8787/abot/realtime";
const DEFAULT_BRIDGE_HEALTH_URL = "http://127.0.0.1:8787/abot/health";
const DEFAULT_BRIDGE_AGENT_MODE_URL = "http://127.0.0.1:8787/abot/agent-mode";
const DEFAULT_ASSISTANT_HOST_URL = "http://127.0.0.1:5188";
const DEFAULT_ENVIRONMENT_ID = "prod";
const DEFAULT_SETUP_COMMAND_MODE = "source";

export type WebUiSetupCommandMode = "source" | "package";

export type WebUiEnvironmentOption = {
  id: string;
  label: string;
  isDefault: boolean;
};

type WebUiServerOptions = {
  host?: string;
  port?: number;
  backend?: "runtime" | "bridge";
  apiBaseUrl?: string;
  realtimeUrl?: string;
  healthUrl?: string;
  agentModeUrl?: string;
  assistantHostUrl?: string;
  apiToken?: string;
  defaultEnvironmentId?: string;
  environments?: WebUiEnvironmentOption[];
  appDir?: string;
  rootDir?: string;
  configPath?: string;
  setupCommandMode?: WebUiSetupCommandMode;
  providerAdapters?: ModelProviderAdapterRegistry;
};

type WebUiServerHandle = {
  close: () => Promise<void>;
};

type ResolvedWebUiServerOptions = Required<
  Omit<
    WebUiServerOptions,
    "appDir" | "rootDir" | "configPath" | "providerAdapters"
  >
> & {
  appDir: string;
  rootDir?: string;
  configPath?: string;
  providerAdapters?: ModelProviderAdapterRegistry;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getConfigString(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const raw = value[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function resolveWebApiToken(): string {
  return (
    process.env.LLM_RUNTIME_WEB_API_TOKEN ||
    process.env.CHAT_API_AUTH_TOKEN ||
    process.env.CHAT_HISTORY_API_TOKEN ||
    ""
  );
}

export function resolveWebUiEnvironmentConfig(params: {
  rootDir: string;
  configPath?: string;
  defaultEnvironmentId?: string;
}): {
  defaultEnvironmentId: string;
  environments: WebUiEnvironmentOption[];
} {
  const overrideDefault = params.defaultEnvironmentId?.trim() ?? "";
  const fallbackDefault = overrideDefault || DEFAULT_ENVIRONMENT_ID;
  const fallback = {
    defaultEnvironmentId: fallbackDefault,
    environments: [
      {
        id: fallbackDefault,
        label: fallbackDefault,
        isDefault: true,
      },
    ],
  };

  let config: Record<string, unknown>;
  try {
    config = inspectRuntimeConfigFileWithMeta(
      params.rootDir,
      params.configPath,
    ).config;
  } catch {
    // Runtime configuration errors belong to the backend catalog response so
    // the Web UI can start and present the actionable setup error.
    return fallback;
  }
  const environment = isRecord(config.environment)
    ? config.environment
    : undefined;
  const profiles = isRecord(environment?.profiles)
    ? environment.profiles
    : undefined;
  const profileIds = profiles
    ? Object.keys(profiles).filter((id) => id.trim().length > 0)
    : [];
  const configuredDefault = getConfigString(environment, "default");
  const defaultEnvironmentId =
    overrideDefault ||
    configuredDefault ||
    profileIds[0] ||
    DEFAULT_ENVIRONMENT_ID;
  const environmentIds =
    profileIds.length > 0 ? [...profileIds] : [defaultEnvironmentId];
  if (!environmentIds.includes(defaultEnvironmentId)) {
    environmentIds.unshift(defaultEnvironmentId);
  }

  return {
    defaultEnvironmentId,
    environments: environmentIds.map((id) => ({
      id,
      label: id,
      isDefault: id === defaultEnvironmentId,
    })),
  };
}

function getOptionsFromEnv(): {
  host: string;
  port: number;
  backend: "runtime" | "bridge";
  apiBaseUrl: string;
  realtimeUrl: string;
  healthUrl: string;
  agentModeUrl: string;
  assistantHostUrl: string;
  apiToken: string;
  defaultEnvironmentId?: string;
  rootDir: string;
  configPath?: string;
  setupCommandMode: WebUiSetupCommandMode;
} {
  loadDotEnvFile();
  const address = resolveWebUiAddress(process.env);
  const backend =
    process.env.LLM_RUNTIME_WEB_BACKEND === "bridge"
      ? "bridge"
      : DEFAULT_WEB_BACKEND;
  const rootDir = process.cwd();
  const configPath = process.env.LLM_RUNTIME_CONFIG_FILE;
  return {
    host: address.listenHost,
    port: address.port,
    backend,
    apiBaseUrl:
      process.env.LLM_RUNTIME_WEB_API_BASE_URL || DEFAULT_BRIDGE_API_BASE,
    realtimeUrl:
      process.env.LLM_RUNTIME_WEB_REALTIME_URL || DEFAULT_BRIDGE_REALTIME_URL,
    healthUrl:
      process.env.LLM_RUNTIME_WEB_HEALTH_URL || DEFAULT_BRIDGE_HEALTH_URL,
    agentModeUrl:
      process.env.LLM_RUNTIME_WEB_AGENT_MODE_URL ||
      DEFAULT_BRIDGE_AGENT_MODE_URL,
    assistantHostUrl:
      process.env.LLM_RUNTIME_WEB_ASSISTANT_HOST_URL ||
      DEFAULT_ASSISTANT_HOST_URL,
    apiToken: resolveWebApiToken(),
    defaultEnvironmentId: process.env.LLM_RUNTIME_WEB_ENVIRONMENT,
    rootDir,
    configPath,
    setupCommandMode: DEFAULT_SETUP_COMMAND_MODE,
  };
}

function resolveAppDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  return resolve(process.cwd(), "src/web-ui/app");
}

function contentTypeFor(pathname: string): string {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function serveStaticFile(
  requestedPath: string,
  res: ServerResponse,
  appDir: string,
): Promise<boolean> {
  const relative = normalize(decodeURIComponent(requestedPath)).replace(
    /^[/\\]+/,
    "",
  );
  const filePath = resolve(appDir, relative);
  if (!filePath.startsWith(appDir)) {
    sendJson(res, 403, { ok: false, error: "invalid_static_path" });
    return true;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      "cache-control": "no-store",
    });
    createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  appDir: string,
): Promise<void> {
  const incomingUrl = new URL(req.url || "/", "http://localhost");
  const requestedPath =
    incomingUrl.pathname === "/" ? "/index.html" : incomingUrl.pathname;
  if (await serveStaticFile(requestedPath, res, appDir)) {
    return;
  }
  if (!incomingUrl.pathname.includes(".")) {
    if (await serveStaticFile("/index.html", res, appDir)) {
      return;
    }
  }
  sendJson(res, 404, { ok: false, error: "not_found" });
}

export function startWebUiServer(
  overrides: WebUiServerOptions = {},
): WebUiServerHandle {
  const envOptions = getOptionsFromEnv();
  const rootDir = overrides.rootDir ?? envOptions.rootDir;
  const configPath = overrides.configPath ?? envOptions.configPath;
  const environmentConfig = resolveWebUiEnvironmentConfig({
    rootDir,
    configPath,
    defaultEnvironmentId:
      overrides.defaultEnvironmentId ?? envOptions.defaultEnvironmentId,
  });
  const options: ResolvedWebUiServerOptions = {
    ...envOptions,
    ...environmentConfig,
    ...overrides,
    appDir: resolveAppDir(overrides.appDir),
    rootDir,
    configPath,
    defaultEnvironmentId:
      overrides.defaultEnvironmentId ?? environmentConfig.defaultEnvironmentId,
    environments: overrides.environments ?? environmentConfig.environments,
  };
  const wss = new WebSocketServer({ noServer: true });
  const localRuntimeBackend =
    options.backend === "runtime"
      ? new LocalRuntimeWebBackend({
          rootDir: options.rootDir,
          configPath: options.configPath,
          defaultEnvironmentId: options.defaultEnvironmentId,
          ...(options.providerAdapters
            ? { providerAdapters: options.providerAdapters }
            : {}),
        })
      : null;
  const externalBridgeBackend =
    options.backend === "bridge"
      ? new ExternalBridgeWebBackend({
          apiBaseUrl: options.apiBaseUrl,
          realtimeUrl: options.realtimeUrl,
          healthUrl: options.healthUrl,
          agentModeUrl: options.agentModeUrl,
          assistantHostUrl: options.assistantHostUrl,
          apiToken: options.apiToken,
        })
      : null;
  if (localRuntimeBackend) {
    wss.on("connection", (client) => {
      localRuntimeBackend.handleRealtimeConnection(client);
    });
  } else if (externalBridgeBackend) {
    wss.on("connection", (client) => {
      externalBridgeBackend.handleRealtimeConnection(client);
    });
  }

  const server = createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      if (pathname === "/web-config") {
        sendJson(res, 200, {
          ok: true,
          apiBasePath: "/web-api",
          healthPath: "/web-health",
          agentModePath: "/web-agent-mode",
          assistantHostPath: "/assistant-host",
          realtimePath: "/web-realtime",
          defaultEnvironmentId: options.defaultEnvironmentId,
          environments: options.environments,
          authConfigured: Boolean(options.apiToken),
          backend: options.backend,
          setupCommandMode: options.setupCommandMode,
        });
        return;
      }
      if (pathname === "/web-health" || pathname === "/web-api/health") {
        if (localRuntimeBackend) {
          await localRuntimeBackend.handleHttp(req, res, pathname);
          return;
        }
        await externalBridgeBackend?.handleHttp(req, res, pathname);
        return;
      }
      if (
        pathname === "/web-agent-mode" ||
        pathname === "/web-api/agent-mode"
      ) {
        if (localRuntimeBackend) {
          await localRuntimeBackend.handleHttp(req, res, pathname);
          return;
        }
        await externalBridgeBackend?.handleHttp(req, res, pathname);
        return;
      }
      if (pathname.startsWith("/web-api/") || pathname === "/web-api") {
        if (localRuntimeBackend) {
          await localRuntimeBackend.handleHttp(req, res, pathname);
          return;
        }
        await externalBridgeBackend?.handleHttp(req, res, pathname);
        return;
      }
      if (
        pathname.startsWith("/assistant-host/") ||
        pathname === "/assistant-host"
      ) {
        if (localRuntimeBackend) {
          if (await localRuntimeBackend.handleHttp(req, res, pathname)) {
            return;
          }
        }
        if (await externalBridgeBackend?.handleHttp(req, res, pathname)) {
          return;
        }
        return;
      }
      await serveStatic(req, res, options.appDir);
    })().catch((error) => {
      sendJson(res, 500, {
        ok: false,
        error: "web_ui_server_error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname !== "/web-realtime") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  server.listen(options.port, options.host, () => {
    console.log(
      `abot web UI listening on http://${options.host}:${options.port}`,
    );
    if (localRuntimeBackend) {
      console.log("using local abot backend");
    } else if (externalBridgeBackend) {
      console.log(`using external bridge HTTP ${options.apiBaseUrl}`);
      console.log(`using external bridge realtime ${options.realtimeUrl}`);
    }
  });

  return {
    close: () =>
      new Promise((resolveClose, reject) => {
        wss.close();
        server.close((error) => {
          if (error) reject(error);
          else resolveClose();
        });
      }),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  startWebUiServer();
}
