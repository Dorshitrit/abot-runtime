import { deserialize, serialize } from "node:v8";

export type RpcFrame =
  | { kind: "call"; id: string; method: string; args: readonly unknown[] }
  | { kind: "result"; id: string; value: unknown }
  | { kind: "error"; id: string; message: string; name?: string; code?: string }
  | { kind: "event"; value: unknown };

export function encodeRpcFrame(frame: RpcFrame): Buffer {
  return serialize(frame);
}

export function decodeRpcFrame(data: Buffer): RpcFrame {
  const frame: unknown = deserialize(data);
  if (!isRpcRecord(frame)) throw new Error("local_runtime_invalid_frame");
  if (frame.kind === "event") return { kind: "event", value: frame.value };
  if (!hasRpcCorrelation(frame)) throw new Error("local_runtime_invalid_frame");
  if (frame.kind === "result")
    return { kind: "result", id: frame.id, value: frame.value };
  if (frame.kind === "error" && typeof frame.message === "string")
    return {
      kind: "error",
      id: frame.id,
      message: frame.message,
      ...(typeof frame.name === "string" ? { name: frame.name } : {}),
      ...(typeof frame.code === "string" ? { code: frame.code } : {}),
    };
  if (hasRpcInvocation(frame))
    return {
      kind: "call",
      id: frame.id,
      method: frame.method,
      args: frame.args,
    };
  throw new Error("local_runtime_invalid_frame");
}

function isRpcRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  return !Array.isArray(value);
}

function hasRpcCorrelation(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { id: string } {
  return typeof value.id === "string" && value.id.length > 0;
}

function hasRpcInvocation(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  kind: "call";
  method: string;
  args: unknown[];
} {
  if (value.kind !== "call") return false;
  if (typeof value.method !== "string" || !value.method) return false;
  return Array.isArray(value.args);
}
