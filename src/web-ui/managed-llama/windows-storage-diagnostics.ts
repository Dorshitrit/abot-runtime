import { channel } from "node:diagnostics_channel";
import type { WindowsStorageAccess } from "./windows-storage.js";

const failures = channel("abot.managed-llama.windows-storage-failure");
const spawnCodes = new Set([
  "ENOENT", "EACCES", "EPERM", "EAGAIN", "EMFILE", "ENFILE", "ENOMEM", "ENOTDIR", "ENOEXEC", "EINVAL",
]);
const signals = new Set(["SIGTERM", "SIGKILL", "SIGABRT", "SIGINT", "SIGBREAK"]);
const accessModes = new Set(["path", "private", "create-directory", "create-file"]);
const outputLimitCode = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

type FailureKind = "timeout" | "output-limit" | "spawn" | "process-exit" | "unknown";

function ownValue(error: unknown, field: string): unknown {
  if (!error || typeof error !== "object") return undefined;
  try { return Object.getOwnPropertyDescriptor(error, field)?.value; }
  catch { return undefined; }
}

function classifyFailure(evidence: {
  code?: string; signal?: string; exitCode?: number; killed?: boolean;
  elapsed: number; timeoutMs: number;
}): FailureKind {
  if (evidence.code === outputLimitCode) return "output-limit";
  if (evidence.killed === true && evidence.signal === "SIGTERM" && evidence.elapsed >= evidence.timeoutMs) return "timeout";
  if (evidence.code && spawnCodes.has(evidence.code)) return "spawn";
  if (evidence.exitCode !== undefined) return "process-exit";
  return "unknown";
}

/** Internal opt-in evidence only. Never retain child output, paths or error messages. */
export function publishWindowsStorageFailure(
  error: unknown,
  access: WindowsStorageAccess,
  elapsed: number,
  timeoutMs: number,
): void {
  if (!failures.hasSubscribers) return;
  const rawCode = ownValue(error, "code");
  const rawSignal = ownValue(error, "signal");
  const rawKilled = ownValue(error, "killed");
  const code = typeof rawCode === "string" && (spawnCodes.has(rawCode) || rawCode === outputLimitCode)
    ? rawCode : undefined;
  const signal = typeof rawSignal === "string" && signals.has(rawSignal) ? rawSignal : undefined;
  const exitCode = typeof rawCode === "number" && Number.isInteger(rawCode) && Math.abs(rawCode) <= 0xffff_ffff
    ? rawCode : undefined;
  const killed = typeof rawKilled === "boolean" ? rawKilled : undefined;
  const elapsedMs = Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0;
  failures.publish(Object.freeze({
    kind: classifyFailure({ code, signal, exitCode, killed, elapsed, timeoutMs }),
    access: accessModes.has(access) ? access : "unknown",
    elapsedMs,
    ...(code ? { code } : {}),
    ...(signal ? { signal } : {}),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(killed === undefined ? {} : { killed }),
  }));
}
