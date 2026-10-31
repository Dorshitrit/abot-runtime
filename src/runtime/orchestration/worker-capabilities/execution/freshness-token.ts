export type RootExecutionFreshnessToken = Readonly<{
  kind: "request_steering_v1";
  version: number;
  updates: readonly Readonly<{ sequence: number; text: string }>[];
}>;

export type WorkerExecutionFreshnessToken = Readonly<{
  kind: "worker_steering_v1";
  callId: string;
  version: number;
}>;

export type CapabilityExecutionFreshnessToken =
  | RootExecutionFreshnessToken
  | WorkerExecutionFreshnessToken;

export function isExecutionFreshnessToken(
  input: unknown,
): input is CapabilityExecutionFreshnessToken {
  if (typeof input !== "object" || input === null) return false;
  const token = input as Record<string, unknown>;
  if (!Number.isSafeInteger(token.version) || (token.version as number) < 0)
    return false;
  if (token.kind === "worker_steering_v1") {
    return typeof token.callId === "string" && token.callId.length > 0;
  }
  if (token.kind !== "request_steering_v1") return false;
  if (!Array.isArray(token.updates) || token.updates.length !== token.version)
    return false;
  return token.updates.every((entry: unknown, index: number) => {
    if (typeof entry !== "object" || entry === null) return false;
    const update = entry as Record<string, unknown>;
    if (update.sequence !== index + 1) return false;
    return typeof update.text === "string" && update.text.trim().length > 0;
  });
}

export function copyExecutionFreshnessToken(
  token: CapabilityExecutionFreshnessToken,
): CapabilityExecutionFreshnessToken {
  if (token.kind === "worker_steering_v1")
    return Object.freeze({
      kind: token.kind,
      callId: token.callId,
      version: token.version,
    });
  return Object.freeze({
    kind: token.kind,
    version: token.version,
    updates: Object.freeze(
      token.updates.map(({ sequence, text }) =>
        Object.freeze({ sequence, text }),
      ),
    ),
  });
}
