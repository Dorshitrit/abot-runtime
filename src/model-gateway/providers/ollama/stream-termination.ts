/** A provider stream failed instead of completing its output. */
export class OllamaStreamTerminationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaStreamTerminationError";
  }
}

export function assertOllamaFrameSucceeded(json: unknown): void {
  if (!json || typeof json !== "object" || Array.isArray(json)) return;
  const error = (json as Record<string, unknown>).error;
  if (typeof error !== "string") return;
  throw new OllamaStreamTerminationError(
    `ollama_stream_error: ${error || "provider generation failed"}`,
  );
}

export function assertOllamaStreamCompleted(terminalReceived: boolean): void {
  if (terminalReceived) return;
  throw new OllamaStreamTerminationError("ollama_stream_missing_terminal");
}
