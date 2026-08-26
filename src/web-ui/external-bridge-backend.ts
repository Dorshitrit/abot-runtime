import type { IncomingMessage, ServerResponse } from "node:http";
import WebSocket from "ws";

export type ExternalBridgeBackendOptions = {
  apiBaseUrl: string;
  realtimeUrl: string;
  healthUrl: string;
  agentModeUrl: string;
  assistantHostUrl: string;
  apiToken: string;
};

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

function joinUrlPath(basePath: string, nextPath: string): string {
  const cleanBase = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const cleanRuntime = nextPath.startsWith("/") ? nextPath : `/${nextPath}`;
  return `${cleanBase}${cleanRuntime}`;
}

function normalizedEnvironmentId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function mirrorEnvironmentToLegacyAgentId(target: URL): void {
  const environmentId = normalizedEnvironmentId(
    target.searchParams.get("environment") ??
      target.searchParams.get("environmentId"),
  );
  if (environmentId && !target.searchParams.has("agentId")) {
    target.searchParams.set("agentId", environmentId);
  }
}

function addLegacyAgentIdToJsonBody(
  req: IncomingMessage,
  body: Buffer | undefined,
): Buffer | undefined {
  if (!body || body.length === 0) return body;
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.includes("json")) {
    return body;
  }

  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return body;
    }
    const record = parsed as Record<string, unknown>;
    const environmentId = normalizedEnvironmentId(
      record.environment ?? record.environmentId,
    );
    if (!environmentId || typeof record.agentId === "string") {
      return body;
    }
    return Buffer.from(
      JSON.stringify({
        ...record,
        agentId: environmentId,
      }),
      "utf8",
    );
  } catch {
    return body;
  }
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function addLegacyAgentIdToRealtimeMessage(
  data: WebSocket.RawData,
): WebSocket.RawData {
  const buffer = rawDataToBuffer(data);
  try {
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return data;
    }
    const record = parsed as Record<string, unknown>;
    const environmentId = normalizedEnvironmentId(
      record.environment ?? record.environmentId,
    );
    if (!environmentId || typeof record.agentId === "string") {
      return data;
    }
    return Buffer.from(
      JSON.stringify({
        ...record,
        agentId: environmentId,
      }),
      "utf8",
    );
  } catch {
    return data;
  }
}

function proxyHeaders(
  req: IncomingMessage,
  apiToken: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const accept = req.headers.accept;
  const contentType = req.headers["content-type"];
  if (typeof accept === "string") headers.accept = accept;
  if (typeof contentType === "string") headers["content-type"] = contentType;
  if (apiToken) headers["x-chat-api-token"] = apiToken;
  return headers;
}

async function sendUpstreamResponse(
  res: ServerResponse,
  upstreamResponse: Response,
  transformJson?: (payload: unknown) => unknown,
): Promise<void> {
  res.statusCode = upstreamResponse.status;
  upstreamResponse.headers.forEach((value, key) => {
    if (
      key === "content-encoding" ||
      key === "content-length" ||
      key === "transfer-encoding"
    ) {
      return;
    }
    res.setHeader(key, value);
  });
  const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
  if (transformJson && upstreamResponse.ok) {
    try {
      const parsed = JSON.parse(responseBody.toString("utf8")) as unknown;
      res.end(JSON.stringify(transformJson(parsed)));
      return;
    } catch {
      // Preserve malformed or non-JSON bridge responses for the client-owned
      // protocol error path instead of disguising them as a valid catalog.
    }
  }
  res.end(responseBody);
}

function normalizeLegacyModelCatalog(payload: unknown): unknown {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return payload;
  }
  const catalog = payload as Record<string, unknown>;
  if (
    catalog.availability !== null &&
    typeof catalog.availability === "object" &&
    !Array.isArray(catalog.availability)
  ) {
    return payload;
  }
  const profiles = Array.isArray(catalog.profiles) ? catalog.profiles : [];
  const availability =
    profiles.length > 0
      ? { status: "ready" }
      : {
          status: "setup_required",
          code: "runtime_configuration_required",
          message:
            "The external bridge did not report an available model profile.",
        };
  return { ...catalog, availability };
}

export class ExternalBridgeWebBackend {
  constructor(private readonly options: ExternalBridgeBackendOptions) {}

  async handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (pathname === "/web-health" || pathname === "/web-api/health") {
      await this.proxyAbsoluteHttpRequest(req, res, this.options.healthUrl, {
        errorCode: "external_bridge_health_unreachable",
      });
      return true;
    }
    if (pathname === "/web-agent-mode" || pathname === "/web-api/agent-mode") {
      await this.proxyAbsoluteHttpRequest(req, res, this.options.agentModeUrl, {
        errorCode: "external_bridge_agent_mode_unreachable",
      });
      return true;
    }
    if (pathname.startsWith("/web-api/") || pathname === "/web-api") {
      await this.proxyApiRequest(req, res);
      return true;
    }
    if (
      pathname.startsWith("/assistant-host/") ||
      pathname === "/assistant-host"
    ) {
      await this.proxyAssistantHostRequest(req, res);
      return true;
    }
    return false;
  }

  handleRealtimeConnection(client: WebSocket): void {
    const queued: WebSocket.RawData[] = [];
    const upstream = new WebSocket(this.options.realtimeUrl, {
      headers: this.options.apiToken
        ? { "x-chat-api-token": this.options.apiToken }
        : undefined,
    });

    upstream.on("open", () => {
      while (queued.length > 0 && upstream.readyState === WebSocket.OPEN) {
        upstream.send(queued.shift() as WebSocket.RawData);
      }
    });

    client.on("message", (data) => {
      const upstreamData = addLegacyAgentIdToRealtimeMessage(data);
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(upstreamData);
        return;
      }
      queued.push(upstreamData);
    });

    upstream.on("message", (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    });

    upstream.on("close", () => {
      if (client.readyState === WebSocket.OPEN) client.close();
    });

    upstream.on("error", (error) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            type: "control",
            name: "external_bridge_realtime_error",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        client.close();
      }
    });

    client.on("close", () => upstream.close());
    client.on("error", () => upstream.close());
  }

  private async proxyApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const incomingUrl = new URL(req.url || "/", "http://localhost");
    const target = new URL(this.options.apiBaseUrl);
    target.pathname = joinUrlPath(
      target.pathname,
      incomingUrl.pathname.slice("/web-api".length),
    );
    target.search = incomingUrl.search;
    mirrorEnvironmentToLegacyAgentId(target);

    await this.proxyRequestToTarget(
      req,
      res,
      target,
      {
        errorCode: "external_bridge_proxy_unreachable",
      },
      (req.method || "GET") === "GET" &&
        incomingUrl.pathname === "/web-api/chat/models"
        ? normalizeLegacyModelCatalog
        : undefined,
    );
  }

  private async proxyAbsoluteHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    targetUrl: string,
    error: { errorCode: string },
  ): Promise<void> {
    const incomingUrl = new URL(req.url || "/", "http://localhost");
    const target = new URL(targetUrl);
    target.search = incomingUrl.search;
    mirrorEnvironmentToLegacyAgentId(target);
    await this.proxyRequestToTarget(req, res, target, error);
  }

  private async proxyAssistantHostRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const incomingUrl = new URL(req.url || "/", "http://localhost");
    const target = new URL(this.options.assistantHostUrl);
    target.pathname = joinUrlPath(
      target.pathname,
      incomingUrl.pathname.slice("/assistant-host".length),
    );
    target.search = incomingUrl.search;

    const method = req.method || "GET";
    const requestBody =
      method === "GET" || method === "HEAD" ? undefined : await readBody(req);

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(target, {
        method,
        headers: {
          accept: "application/json",
          ...(req.headers["content-type"]
            ? { "content-type": String(req.headers["content-type"]) }
            : {}),
        },
        body: requestBody ? new Uint8Array(requestBody) : undefined,
      });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        error: "assistant_host_unreachable",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    await sendUpstreamResponse(res, upstreamResponse);
  }

  private async proxyRequestToTarget(
    req: IncomingMessage,
    res: ServerResponse,
    target: URL,
    error: { errorCode: string },
    transformJson?: (payload: unknown) => unknown,
  ): Promise<void> {
    const method = req.method || "GET";
    const requestBody =
      method === "GET" || method === "HEAD" ? undefined : await readBody(req);
    const upstreamBody = addLegacyAgentIdToJsonBody(req, requestBody);

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(target, {
        method,
        headers: proxyHeaders(req, this.options.apiToken),
        body: upstreamBody ? new Uint8Array(upstreamBody) : undefined,
      });
    } catch (fetchError) {
      sendJson(res, 502, {
        ok: false,
        error: error.errorCode,
        message:
          fetchError instanceof Error ? fetchError.message : String(fetchError),
      });
      return;
    }

    await sendUpstreamResponse(res, upstreamResponse, transformJson);
  }
}
