import { randomUUID } from "node:crypto";
import { traceDebug } from "../../runtime/observability/debug-logger.js";
import { classifyRuntimeErrorType } from "../../runtime/observability/error-type.js";
import type { ModelGatewayRequest, ResolvedModelInvocation } from "../types.js";

type CountPhase = "prepare" | "resolve" | "provider_count" | "measurement_record"
  | "response_write" | "bridge_fetch" | "bridge_response" | "bridge_parse";
type CountFailureKind = "exception" | "provider_result";
const TRANSPORT_CODES = new Set([
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE",
  "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_ABORTED", "ABORT_ERR", "ERR_INVALID_URL",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function boundedDiagnosticId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!/^[a-zA-Z0-9_.:/-]{1,200}$/.test(value)) return undefined;
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function serializedBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    return Buffer.byteLength(serialized);
  } catch {
    return undefined;
  }
}

function countRequestShape(request: ModelGatewayRequest) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  let contentChars = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let attachmentCount = 0;
  for (const item of messages) {
    const message = record(item);
    if (typeof message.content === "string") contentChars += message.content.length;
    if (Array.isArray(message.toolCalls)) toolCallCount += message.toolCalls.length;
    if (message.role === "tool") toolResultCount += 1;
    if (Array.isArray(message.attachments)) attachmentCount += message.attachments.length;
  }
  return {
    messageCount: messages.length, contentChars, toolCallCount, toolResultCount,
    attachmentCount, requestBytes: serializedBytes(request),
    formatBytes: serializedBytes(request.format),
  };
}

/** Only trusted classifications and allowlisted transport codes leave error objects. */
function countErrorDetails(error: unknown) {
  const pending: { value: unknown; relation: string; depth: number }[] = [
    { value: error, relation: "error", depth: 0 },
  ];
  const seen = new Set<unknown>();
  const entries: Record<string, unknown>[] = [];
  while (pending.length > 0 && entries.length < 8) {
    const current = pending.shift()!;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    const value = record(current.value);
    const code = typeof value.code === "string" && TRANSPORT_CODES.has(value.code)
      ? value.code : undefined;
    const aggregate = current.value instanceof AggregateError ? current.value : undefined;
    entries.push({
      relation: current.relation,
      type: aggregate ? "AggregateError" : classifyRuntimeErrorType(current.value),
      ...(code ? { code } : {}),
      ...(typeof value.errno === "number" && Number.isSafeInteger(value.errno)
        ? { errno: value.errno } : {}),
      ...(aggregate ? { aggregateErrorCount: aggregate.errors.length } : {}),
    });
    if (current.depth >= 2) continue;
    if (value.cause !== undefined) {
      pending.push({ value: value.cause, relation: "cause", depth: current.depth + 1 });
    }
    if (!aggregate) continue;
    for (const inner of aggregate.errors.slice(0, 4)) {
      pending.push({ value: inner, relation: "aggregate", depth: current.depth + 1 });
    }
  }
  return entries;
}

/** Request-local metadata only. It never reads response bodies or alters failures. */
export class InputTokenCountDiagnostics {
  private readonly startedAt = Date.now();
  private readonly diagnosticId = randomUUID();
  private phase: CountPhase = "prepare";
  private invocation?: ResolvedModelInvocation;
  private provider?: string;
  private upstream: Record<string, unknown> = {};

  constructor(
    private readonly scope: "model-gateway.client" | "model-gateway.server",
    private readonly requestBody: ModelGatewayRequest,
  ) {}

  setPhase(phase: CountPhase): void { this.phase = phase; }
  setProvider(provider: string): void { this.provider = provider; }
  bindInvocation(invocation: ResolvedModelInvocation): void { this.invocation = invocation; }

  observeFetch(fetchImpl: typeof fetch): typeof fetch {
    return async (input, init) => {
      const startedAt = Date.now();
      this.upstream = {
        attempted: true,
        requestBytes: typeof init?.body === "string" ? Buffer.byteLength(init.body) : undefined,
      };
      try {
        const response = await fetchImpl(input, init);
        this.upstream = {
          ...this.upstream, ...countFetchResponseMetadata(response, startedAt),
        };
        return response;
      } catch (error) {
        this.upstream = {
          ...this.upstream, responseReceived: false, durationMs: Date.now() - startedAt,
          errors: safelyCountErrorDetails(error),
        };
        throw error;
      }
    };
  }

  failed(params: {
    kind: CountFailureKind;
    aborted: boolean;
    statusCode?: number;
    error?: unknown;
  }): void {
    // Diagnostics must never replace the original terminal outcome.
    try {
      const invocation = this.invocation;
      traceDebug(this.scope, "input_tokens.request.failed", {
        diagnosticId: this.diagnosticId,
        requestId: boundedDiagnosticId(this.requestBody.debugRequestId),
        modelStep: boundedDiagnosticId(this.requestBody.modelStep),
        phase: this.phase, failureKind: params.kind,
        aborted: params.aborted, statusCode: params.statusCode,
        durationMs: Date.now() - this.startedAt,
        profileId: boundedDiagnosticId(invocation?.profile.id),
        providerId: boundedDiagnosticId(invocation?.profile.providerId),
        provider: boundedDiagnosticId(invocation?.profile.provider ?? this.provider),
        model: boundedDiagnosticId(invocation?.model),
        requestShape: countRequestShape(this.requestBody),
        upstream: this.upstream,
        ...(params.error !== undefined ? { errors: safelyCountErrorDetails(params.error) } : {}),
      });
    } catch {
      // The existing transport/error mapping remains authoritative.
    }
  }
}

function safelyCountErrorDetails(error: unknown): Record<string, unknown>[] {
  try { return countErrorDetails(error); }
  catch { return [{ type: "unknown", relation: "error" }]; }
}

function countFetchResponseMetadata(response: Response, startedAt: number) {
  const metadata = { responseReceived: true, durationMs: Date.now() - startedAt };
  try {
    return {
      ...metadata, statusCode: response.status,
      requestId: boundedDiagnosticId(response.headers.get("x-request-id")),
    };
  } catch {
    return metadata;
  }
}
