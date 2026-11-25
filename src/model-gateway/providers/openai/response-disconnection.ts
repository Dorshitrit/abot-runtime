import { ProviderStreamDisconnectionError } from "../../protocol/provider-stream-disconnection.js";

const DISCONNECTED_READ_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);

function hasDisconnectedReadCode(error: unknown): boolean {
  const seen = new Set<Error>();
  let current = error;
  let disconnected = false;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(current instanceof Error)) return disconnected;
    if (seen.has(current)) return false;
    if (current.name === "AbortError" || current.name === "TimeoutError") return false;
    if ("code" in current && typeof current.code === "string" && DISCONNECTED_READ_CODES.has(current.code)) {
      disconnected = true;
    }
    seen.add(current);
    current = current.cause;
  }
  return false;
}

/** One upstream send owns this evidence, shared only with its trace and consumers. */
export class OpenAIResponseDisconnectionEvidence {
  private responseId?: string;
  private disqualified = false;
  private upstreamEof = false;

  constructor(private readonly signal?: AbortSignal) {}

  observeEvent(event: unknown): void {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      this.disqualify();
      return;
    }
    const value = event as Record<string, unknown>;
    if (typeof value.type !== "string") { this.disqualify(); return; }
    if (value.type !== "response.created" && value.type !== "response.in_progress") return;
    const response = value.response as Record<string, unknown> | undefined;
    if (!response || typeof response.id !== "string" || !response.id.trim()) {
      this.disqualify();
      return;
    }
    if (response.status !== "in_progress" && response.status !== "queued") {
      this.disqualify();
      return;
    }
    if (this.responseId && this.responseId !== response.id) { this.disqualify(); return; }
    this.responseId = response.id;
  }

  disqualify(): void { this.disqualified = true; }

  recordUpstreamEof(): void { this.upstreamEof = true; }

  private canClassifyDisconnection(): boolean {
    if (this.signal?.aborted) return false;
    return !this.disqualified;
  }

  /** Catch only the actual upstream reader; parser, sink and local faults stay untyped. */
  async read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
    try {
      return await reader.read();
    } catch (error) {
      if (!this.canClassifyDisconnection()) throw error;
      if (!hasDisconnectedReadCode(error)) throw error;
      const classified = new Error(error instanceof Error ? error.message : "provider stream disconnected", {
        cause: new ProviderStreamDisconnectionError(),
      });
      if (error instanceof Error) classified.name = error.name;
      throw classified;
    }
  }

  /** Clean EOF stays clean for the byte trace; only decoding rejects the incomplete output. */
  assertNotDisconnected(functionOutputName?: string): void {
    if (!this.canClassifyDisconnection()) return;
    if (!this.upstreamEof || !this.responseId) return;
    const message = functionOutputName
      ? "openai function response not completed"
      : "openai response not completed";
    throw new Error(message, { cause: new ProviderStreamDisconnectionError() });
  }
}
