import type WebSocket from "ws";

import {
  getRuntimeConfig,
  getRuntimeConfigSchema,
  patchRuntimeConfig,
  validateRuntimeConfigCandidate,
} from "../runtime/admin/config-control.js";
import {
  getRuntimeStatus,
  requestRuntimeManagedServiceRestart,
  requestRuntimeRestart,
  tailRuntimeLog,
  type RuntimeManagedServiceRestartHandler,
  type RuntimeRestartHandler,
} from "../runtime/admin/system-control.js";

type JsonObject = Record<string, unknown>;

function getString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sendRuntimeAdminResponse(ws: WebSocket, payload: JsonObject): void {
  ws.send(JSON.stringify(payload));
}

function sendFailure(
  ws: WebSocket,
  type: string,
  correlationId: string,
  error: string,
  extra: JsonObject = {},
): void {
  sendRuntimeAdminResponse(ws, {
    type,
    correlationId,
    ok: false,
    ...extra,
    error,
  });
}

export async function handleRuntimeAdminBridgeMessage(
  ws: WebSocket,
  msg: JsonObject,
  options: {
    rootDir?: string;
    configPath?: string;
    env?: Record<string, string | undefined>;
    modelGatewayUrl?: string;
    modelGatewayRestartFetch?: typeof fetch;
    restartHandler?: RuntimeRestartHandler;
    managedServiceRestartHandler?: RuntimeManagedServiceRestartHandler;
  } = {},
): Promise<boolean> {
  const type = getString(msg.type);
  switch (type) {
    case "runtime.status.get":
      handleStatusGet(ws, msg, options);
      return true;
    case "runtime.logs.tail":
      await handleLogsTail(ws, msg, options);
      return true;
    case "runtime.restart.request":
      handleRestartRequest(ws, msg, options);
      return true;
    case "runtime.service.restart.request":
      handleManagedServiceRestartRequest(ws, msg, options);
      return true;
    case "runtime.config.get":
      handleConfigGet(ws, msg, options);
      return true;
    case "runtime.config.schema":
      handleConfigSchema(ws, msg);
      return true;
    case "runtime.config.validate":
      handleConfigValidate(ws, msg, options);
      return true;
    case "runtime.config.patch":
      await handleConfigPatch(ws, msg, options);
      return true;
    default:
      return false;
  }
}

function handleManagedServiceRestartRequest(
  ws: WebSocket,
  msg: JsonObject,
  options: {
    managedServiceRestartHandler?: RuntimeManagedServiceRestartHandler;
  },
): void {
  const correlationId = requireCorrelationId(
    ws,
    "runtime.service.restart.request.response",
    msg,
  );
  if (!correlationId) {
    return;
  }

  try {
    sendRuntimeAdminResponse(ws, {
      type: "runtime.service.restart.request.response",
      correlationId,
      ok: true,
      restart: requestRuntimeManagedServiceRestart(
        {
          serviceId: msg.serviceId,
          delayMs: msg.delayMs,
        },
        options.managedServiceRestartHandler,
      ),
    });
  } catch (error) {
    sendFailure(
      ws,
      "runtime.service.restart.request.response",
      correlationId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function handleStatusGet(
  ws: WebSocket,
  msg: JsonObject,
  options: {
    rootDir?: string;
    configPath?: string;
    env?: Record<string, string | undefined>;
  },
): void {
  const correlationId = requireCorrelationId(
    ws,
    "runtime.status.get.response",
    msg,
  );
  if (!correlationId) {
    return;
  }

  try {
    sendRuntimeAdminResponse(ws, {
      type: "runtime.status.get.response",
      correlationId,
      ok: true,
      status: getRuntimeStatus(options),
    });
  } catch (error) {
    sendFailure(
      ws,
      "runtime.status.get.response",
      correlationId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleLogsTail(
  ws: WebSocket,
  msg: JsonObject,
  options: {
    rootDir?: string;
    configPath?: string;
    env?: Record<string, string | undefined>;
  },
): Promise<void> {
  const correlationId = requireCorrelationId(
    ws,
    "runtime.logs.tail.response",
    msg,
  );
  if (!correlationId) {
    return;
  }

  try {
    sendRuntimeAdminResponse(ws, {
      type: "runtime.logs.tail.response",
      correlationId,
      ok: true,
      log: await tailRuntimeLog({
        rootDir: options.rootDir,
        configPath: options.configPath,
        env: options.env,
        lines: msg.lines,
        maxBytes: msg.maxBytes,
      }),
    });
  } catch (error) {
    sendFailure(
      ws,
      "runtime.logs.tail.response",
      correlationId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function handleRestartRequest(
  ws: WebSocket,
  msg: JsonObject,
  options: {
    modelGatewayUrl?: string;
    modelGatewayRestartFetch?: typeof fetch;
    restartHandler?: RuntimeRestartHandler;
  },
): void {
  const correlationId = requireCorrelationId(
    ws,
    "runtime.restart.request.response",
    msg,
  );
  if (!correlationId) {
    return;
  }

  try {
    sendRuntimeAdminResponse(ws, {
      type: "runtime.restart.request.response",
      correlationId,
      ok: true,
      restart: requestRuntimeRestart(
        {
          reason: msg.reason,
          delayMs: msg.delayMs,
        },
        options.restartHandler,
        {
          url: options.modelGatewayUrl,
          fetchImpl: options.modelGatewayRestartFetch,
        },
      ),
    });
  } catch (error) {
    sendFailure(
      ws,
      "runtime.restart.request.response",
      correlationId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function requireCorrelationId(
  ws: WebSocket,
  responseType: string,
  msg: JsonObject,
): string | null {
  const correlationId = getString(msg.correlationId);
  if (!correlationId) {
    sendFailure(ws, responseType, "", "correlationId required");
    return null;
  }
  return correlationId;
}

function handleConfigGet(
  ws: WebSocket,
  msg: JsonObject,
  options: {
    rootDir?: string;
    configPath?: string;
    env?: Record<string, string | undefined>;
  },
): void {
  const correlationId = requireCorrelationId(
    ws,
    "runtime.config.get.response",
    msg,
  );
  if (!correlationId) {
    return;
  }

  try {
    const result = getRuntimeConfig(options);
    sendRuntimeAdminResponse(ws, {
      type: "runtime.config.get.response",
      correlationId,
      ok: true,
      ...result,
    });
  } catch (error) {
    sendFailure(
      ws,
      "runtime.config.get.response",
      correlationId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function handleConfigSchema(ws: WebSocket, msg: JsonObject): void {
  const correlationId = requireCorrelationId(
    ws,
    "runtime.config.schema.response",
    msg,
  );
  if (!correlationId) {
    return;
  }
  sendRuntimeAdminResponse(ws, {
    type: "runtime.config.schema.response",
    correlationId,
    ok: true,
    schema: getRuntimeConfigSchema(),
  });
}

function handleConfigValidate(
  ws: WebSocket,
  msg: JsonObject,
  options: {
    rootDir?: string;
    configPath?: string;
  },
): void {
  const correlationId = requireCorrelationId(
    ws,
    "runtime.config.validate.response",
    msg,
  );
  if (!correlationId) {
    return;
  }
  const result = validateRuntimeConfigCandidate({
    rootDir: options.rootDir,
    configPath: options.configPath,
    config: msg.config,
    patch: msg.patch,
  });
  sendRuntimeAdminResponse(ws, {
    type: "runtime.config.validate.response",
    correlationId,
    ...result,
  });
}

async function handleConfigPatch(
  ws: WebSocket,
  msg: JsonObject,
  options: {
    rootDir?: string;
    configPath?: string;
  },
): Promise<void> {
  const correlationId = requireCorrelationId(
    ws,
    "runtime.config.patch.response",
    msg,
  );
  if (!correlationId) {
    return;
  }

  try {
    const result = await patchRuntimeConfig({
      rootDir: options.rootDir,
      configPath: options.configPath,
      patch: msg.patch,
    });
    sendRuntimeAdminResponse(ws, {
      type: "runtime.config.patch.response",
      correlationId,
      ...result,
    });
  } catch (error) {
    sendFailure(
      ws,
      "runtime.config.patch.response",
      correlationId,
      error instanceof Error ? error.message : String(error),
      { restartRequired: false },
    );
  }
}
