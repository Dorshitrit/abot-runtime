import WebSocket from "ws";

import { handleRunRequest } from "../runtime/request/handler.js";
import type {
  RequestHandlerOptions,
  RunRequestMessage,
} from "../runtime/request/contracts.js";
import type { RuntimeRequestHandler } from "../runtime/composition.js";
import { traceDebug } from "../runtime/observability/debug-logger.js";
import { normalizeRuntimeId } from "../shared/agent.js";
import { DEFAULT_AGENT_BRIDGE_URL } from "../shared/constants.js";
import { loadDotEnvFile } from "../shared/load-dotenv.js";
import { handleRuntimeAdminBridgeMessage } from "./runtime-admin.js";
import { handleRuntimeReplayBridgeMessage } from "./runtime-replay.js";
import { createBridgeRequestSteeringRegistry } from "./request-steering.js";
import type {
  EventSinkFactory,
  ModelGatewayClient,
  RuntimeConfig,
  SessionStore,
  ToolApprovalController,
  ToolApprovalDecision,
  ToolRegistry,
} from "../runtime/ports.js";
import type { RuntimeAttachmentStore } from "../runtime/attachments/store.js";
import { loadRuntimeModelCatalog } from "../runtime/model/model-catalog.js";
import { REQUEST_STEERING_FEATURE } from "../runtime/request/request-steering.js";

export type AgentBridgeOptions = {
  runtimeConfig?: RuntimeConfig;
  url?: string;
  token?: string;
  runtimeId?: string;
  eventSinkFactory?: EventSinkFactory;
  modelGatewayClient?: ModelGatewayClient;
  sessionStore?: SessionStore;
  attachmentStore?: RuntimeAttachmentStore;
  toolRegistry?: ToolRegistry;
  requestHandler?: RuntimeRequestHandler;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  reconnectJitterRatio?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  statusLogIntervalMs?: number;
  lifecycleTraceEnabled?: boolean;
};

export type AgentBridgeHandle = {
  stop: () => Promise<void>;
  getStatus: () => AgentBridgeConnectionStatus;
};

export type AgentBridgeConnectionStatus = {
  runtimeId: string;
  url: string;
  connectionId: number;
  state: "connecting" | "open" | "closed" | "stopped";
  registered: boolean;
  reconnectAttempt: number;
  lastOpenAt?: string;
  lastRegisteredAt?: string;
  lastMessageAt?: string;
  lastPongAt?: string;
  nextReconnectAt?: string;
};

type PendingToolApproval = {
  requestId: string;
  resolve: (decision: ToolApprovalDecision) => void;
};

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_RECONNECT_JITTER_RATIO = 0.2;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90_000;
const DEFAULT_STATUS_LOG_INTERVAL_MS = 0;

function readPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function sanitizeBridgeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.replace(/\/\/[^/@]+@/, "//<redacted>@");
  }
}

function toIso(value: number | undefined): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

function getReadyStateName(ws: WebSocket | undefined): string {
  switch (ws?.readyState) {
    case WebSocket.CONNECTING:
      return "connecting";
    case WebSocket.OPEN:
      return "open";
    case WebSocket.CLOSING:
      return "closing";
    case WebSocket.CLOSED:
      return "closed";
    default:
      return "none";
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "0" || normalized === "false" || normalized === "off") {
    return false;
  }
  return true;
}

export function startAgentBridge(
  options: AgentBridgeOptions = {},
): AgentBridgeHandle {
  loadDotEnvFile();
  const token = options.token || process.env.AGENT_BRIDGE_TOKEN;
  if (!token) throw new Error("AGENT_BRIDGE_TOKEN required");

  const runtimeId = normalizeRuntimeId(
    options.runtimeId || options.runtimeConfig?.runtimeId || "",
  );
  const url =
    options.url || process.env.AGENT_BRIDGE_URL || DEFAULT_AGENT_BRIDGE_URL;
  const logUrl = sanitizeBridgeUrl(url);
  const reconnectBaseMs = readPositiveNumber(
    options.reconnectBaseMs,
    DEFAULT_RECONNECT_BASE_MS,
  );
  const reconnectMaxMs = readPositiveNumber(
    options.reconnectMaxMs,
    DEFAULT_RECONNECT_MAX_MS,
  );
  const reconnectJitterRatio = readNonNegativeNumber(
    options.reconnectJitterRatio,
    DEFAULT_RECONNECT_JITTER_RATIO,
  );
  const heartbeatIntervalMs = readPositiveNumber(
    options.heartbeatIntervalMs,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const heartbeatTimeoutMs = readPositiveNumber(
    options.heartbeatTimeoutMs,
    DEFAULT_HEARTBEAT_TIMEOUT_MS,
  );
  const statusLogIntervalMs = readNonNegativeNumber(
    options.statusLogIntervalMs,
    DEFAULT_STATUS_LOG_INTERVAL_MS,
  );
  const lifecycleTraceEnabled =
    options.lifecycleTraceEnabled ??
    readBooleanEnv(process.env.AGENT_BRIDGE_TRACE_LIFECYCLE) ??
    false;
  const modelCatalog = options.runtimeConfig
    ? {
        schemaVersion: 1 as const,
        ...loadRuntimeModelCatalog(options.runtimeConfig),
      }
    : undefined;
  const requestHandler =
    options.requestHandler ?? createBoundBridgeRequestHandler(options);

  let ws: WebSocket | undefined;
  let stopped = false;
  let registered = false;
  let connectionId = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let statusTimer: NodeJS.Timeout | undefined;
  let nextReconnectAt: number | undefined;
  let lastOpenAt: number | undefined;
  let lastRegisteredAt: number | undefined;
  let lastMessageAt: number | undefined;
  let lastPongAt: number | undefined;
  const pendingToolApprovals = new Map<string, PendingToolApproval>();
  const requestSteering = createBridgeRequestSteeringRegistry(
    requestHandler.steer,
  );

  function getStatus(): AgentBridgeConnectionStatus {
    return {
      runtimeId,
      url: logUrl,
      connectionId,
      state: stopped
        ? "stopped"
        : ws?.readyState === WebSocket.OPEN
          ? "open"
          : ws?.readyState === WebSocket.CONNECTING
            ? "connecting"
            : "closed",
      registered,
      reconnectAttempt,
      lastOpenAt: toIso(lastOpenAt),
      lastRegisteredAt: toIso(lastRegisteredAt),
      lastMessageAt: toIso(lastMessageAt),
      lastPongAt: toIso(lastPongAt),
      nextReconnectAt: toIso(nextReconnectAt),
    };
  }

  function trace(event: string, data: Record<string, unknown> = {}): void {
    traceDebug("agent-bridge.client", event, {
      runtimeId,
      url: logUrl,
      connectionId,
      readyState: getReadyStateName(ws),
      registered,
      reconnectAttempt,
      ...data,
    });
  }

  function traceLifecycle(
    event: string,
    data: Record<string, unknown> = {},
  ): void {
    if (!lifecycleTraceEnabled) {
      return;
    }
    trace(event, data);
  }

  function logStatus(reason: string): void {
    if (!lifecycleTraceEnabled && statusLogIntervalMs <= 0) {
      return;
    }
    trace("status.snapshot", {
      reason,
      status: getStatus(),
    });
  }

  function clearReconnectTimer(): void {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    nextReconnectAt = undefined;
  }

  function clearHeartbeatTimer(): void {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  function clearStatusTimer(): void {
    if (!statusTimer) return;
    clearInterval(statusTimer);
    statusTimer = undefined;
  }

  function createToolApprovalController(): ToolApprovalController {
    return {
      requestToolApproval: (request, options) =>
        new Promise<ToolApprovalDecision>((resolve) => {
          if (options?.abortSignal?.aborted) {
            resolve({
              approved: false,
              reason: "Tool approval was cancelled.",
            });
            return;
          }

          const complete = (decision: ToolApprovalDecision) => {
            pendingToolApprovals.delete(request.approvalId);
            options?.abortSignal?.removeEventListener("abort", onAbort);
            resolve(decision);
          };
          const onAbort = () => {
            complete({
              approved: false,
              reason: "Tool approval was cancelled.",
            });
          };
          options?.abortSignal?.addEventListener("abort", onAbort, {
            once: true,
          });
          pendingToolApprovals.set(request.approvalId, {
            requestId: request.requestId,
            resolve: complete,
          });
          trace("tool_approval.pending", {
            requestId: request.requestId,
            approvalId: request.approvalId,
            tool: request.call.tool,
          });
        }),
    };
  }

  function handleToolApprovalResponse(msg: Record<string, unknown>): boolean {
    if (msg.type !== "tool_approval_response") {
      return false;
    }
    const approvalId = getString(msg.approvalId);
    if (!approvalId) {
      trace("tool_approval.invalid_response", {
        reason: "missing_approval_id",
      });
      return true;
    }
    const pending = pendingToolApprovals.get(approvalId);
    if (!pending) {
      trace("tool_approval.unknown_response", { approvalId });
      return true;
    }
    pending.resolve({
      approved: msg.approved === true,
      reason: getString(msg.reason).trim() || undefined,
    });
    trace("tool_approval.resolved", {
      requestId: pending.requestId,
      approvalId,
      approved: msg.approved === true,
    });
    return true;
  }

  function computeReconnectDelayMs(): number {
    const cappedAttempt = Math.min(reconnectAttempt, 10);
    const baseDelay = Math.min(
      reconnectMaxMs,
      reconnectBaseMs * 2 ** cappedAttempt,
    );
    if (reconnectJitterRatio <= 0) {
      return baseDelay;
    }
    const jitter = baseDelay * reconnectJitterRatio * Math.random();
    return Math.round(baseDelay + jitter);
  }

  function scheduleReconnect(reason: string): void {
    if (stopped || reconnectTimer) {
      return;
    }
    const delayMs = computeReconnectDelayMs();
    reconnectAttempt += 1;
    nextReconnectAt = Date.now() + delayMs;
    trace("reconnect.scheduled", {
      reason,
      delayMs,
      nextReconnectAt: toIso(nextReconnectAt),
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      nextReconnectAt = undefined;
      connect("reconnect");
    }, delayMs);
  }

  function sendRegister(
    currentWs: WebSocket,
    currentConnectionId: number,
  ): void {
    const payload = {
      type: "register",
      agentId: runtimeId,
      features: [REQUEST_STEERING_FEATURE],
      ...(modelCatalog ? { modelCatalog } : {}),
    };
    currentWs.send(JSON.stringify(payload), (error) => {
      if (error) {
        trace("register.send_failed", {
          connectionId: currentConnectionId,
          error: error.message,
        });
        currentWs.terminate();
        return;
      }
      traceLifecycle("register.sent", {
        connectionId: currentConnectionId,
        modelCatalogSchemaVersion: modelCatalog?.schemaVersion,
        modelProfileCount: modelCatalog?.profiles.length ?? 0,
        defaultModelProfileId: modelCatalog?.defaultProfileId,
        features: [REQUEST_STEERING_FEATURE],
      });
    });
  }

  async function handleMessage(
    currentWs: WebSocket,
    currentConnectionId: number,
    raw: WebSocket.RawData,
  ): Promise<void> {
    lastMessageAt = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch (error) {
      trace("message.invalid_json", {
        connectionId: currentConnectionId,
        error: getErrorMessage(error),
        rawLength: raw.toString().length,
      });
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      trace("message.invalid_shape", { connectionId: currentConnectionId });
      return;
    }

    const msg = parsed as Record<string, unknown>;
    const messageType = typeof msg.type === "string" ? msg.type : "";

    if (messageType === "registered") {
      registered = true;
      lastRegisteredAt = Date.now();
      traceLifecycle("registered", { connectionId: currentConnectionId });
      logStatus("registered");
      return;
    }

    try {
      if (
        await handleRuntimeAdminBridgeMessage(currentWs, msg, {
          rootDir: options.runtimeConfig?.paths.rootDir,
          env: process.env,
          modelGatewayUrl: options.runtimeConfig?.modelGatewayUrl,
        })
      ) {
        return;
      }
      if (
        await handleRuntimeReplayBridgeMessage(currentWs, msg, {
          sessionStore: options.sessionStore,
          attachmentStore: options.attachmentStore,
        })
      ) {
        return;
      }
      if (handleToolApprovalResponse(msg)) {
        return;
      }
      if (await requestSteering.handleMessage(currentWs, msg)) {
        return;
      }
      if (msg.type !== "run_request") return;
      const requestId = getString(msg.requestId).trim();
      const steeringInbox = requestSteering.open(requestId);
      try {
        await requestHandler.handle(currentWs, msg as RunRequestMessage, {
          toolApprovalController: createToolApprovalController(),
          requestSteering: steeringInbox,
        });
      } finally {
        await requestSteering.close(requestId, steeringInbox);
      }
    } catch (error) {
      trace("message.handle_failed", {
        connectionId: currentConnectionId,
        messageType,
        error: getErrorMessage(error),
      });
    }
  }

  function startHeartbeat(
    currentWs: WebSocket,
    currentConnectionId: number,
  ): void {
    clearHeartbeatTimer();
    heartbeatTimer = setInterval(() => {
      if (stopped || ws !== currentWs) {
        clearHeartbeatTimer();
        return;
      }
      if (currentWs.readyState !== WebSocket.OPEN) {
        return;
      }
      const now = Date.now();
      const pongAgeMs = lastPongAt ? now - lastPongAt : undefined;
      if (pongAgeMs !== undefined && pongAgeMs > heartbeatTimeoutMs) {
        trace("heartbeat.timeout", {
          connectionId: currentConnectionId,
          pongAgeMs,
          heartbeatTimeoutMs,
        });
        currentWs.terminate();
        return;
      }
      try {
        currentWs.ping();
      } catch (error) {
        trace("heartbeat.ping_failed", {
          connectionId: currentConnectionId,
          error: getErrorMessage(error),
        });
        currentWs.terminate();
      }
    }, heartbeatIntervalMs);
  }

  function connect(reason: string): void {
    if (stopped) {
      return;
    }

    clearReconnectTimer();
    registered = false;
    connectionId += 1;
    const currentConnectionId = connectionId;
    traceLifecycle("connect.start", { reason });

    const currentWs = new WebSocket(url, {
      headers: {
        Authorization: "Bearer " + token,
      },
    });
    ws = currentWs;

    currentWs.on("open", () => {
      if (ws !== currentWs || stopped) {
        currentWs.close();
        return;
      }
      reconnectAttempt = 0;
      lastOpenAt = Date.now();
      lastPongAt = lastOpenAt;
      traceLifecycle("socket.open", { connectionId: currentConnectionId });
      logStatus("open");
      sendRegister(currentWs, currentConnectionId);
      startHeartbeat(currentWs, currentConnectionId);
    });

    currentWs.on("pong", () => {
      if (ws !== currentWs) {
        return;
      }
      lastPongAt = Date.now();
    });

    currentWs.on("message", (raw) => {
      void handleMessage(currentWs, currentConnectionId, raw);
    });

    currentWs.on("error", (error) => {
      trace("socket.error", {
        connectionId: currentConnectionId,
        error: error.message,
      });
    });

    currentWs.on("close", (code, reasonBuffer) => {
      if (ws !== currentWs) {
        return;
      }
      clearHeartbeatTimer();
      registered = false;
      const closeData = {
        connectionId: currentConnectionId,
        code,
        reason: reasonBuffer.toString(),
        stopped,
      };
      if (stopped) {
        traceLifecycle("socket.close", closeData);
      } else {
        trace("socket.close", closeData);
      }
      logStatus(stopped ? "stopped" : "closed");
      if (!stopped) {
        scheduleReconnect("socket_closed");
      }
    });
  }

  if (statusLogIntervalMs > 0) {
    statusTimer = setInterval(() => logStatus("periodic"), statusLogIntervalMs);
  }

  connect("initial");

  return {
    getStatus,
    stop: async () => {
      stopped = true;
      clearReconnectTimer();
      clearHeartbeatTimer();
      clearStatusTimer();
      for (const pending of pendingToolApprovals.values()) {
        pending.resolve({
          approved: false,
          reason: "Tool approval was cancelled.",
        });
      }
      pendingToolApprovals.clear();
      traceLifecycle("stop.requested");
      const currentWs = ws;
      if (
        !currentWs ||
        currentWs.readyState === WebSocket.CLOSED ||
        currentWs.readyState === WebSocket.CLOSING
      ) {
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          currentWs.terminate();
          resolve();
        }, 1_000);
        currentWs.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        currentWs.close();
      });
    },
  };
}

function createBoundBridgeRequestHandler(
  options: Pick<
    AgentBridgeOptions,
    | "runtimeConfig"
    | "eventSinkFactory"
    | "modelGatewayClient"
    | "sessionStore"
    | "attachmentStore"
    | "toolRegistry"
  >,
): RuntimeRequestHandler {
  const environmentOptions: RequestHandlerOptions = {
    runtimeConfig: options.runtimeConfig,
    eventSinkFactory: options.eventSinkFactory,
    modelGatewayClient: options.modelGatewayClient,
    sessionStore: options.sessionStore,
    attachmentStore: options.attachmentStore,
    toolRegistry: options.toolRegistry,
  };
  return {
    handle(ws, message, requestOptions = {}) {
      return handleRunRequest(ws, message, {
        ...environmentOptions,
        ...requestOptions,
      });
    },
  };
}
