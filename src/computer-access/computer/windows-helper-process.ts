import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { NativeComputerRequest } from "./native-protocol.js";

export const WINDOWS_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const WINDOWS_HELPER_MAX_BYTES = Math.ceil(WINDOWS_IMAGE_MAX_BYTES / 3) * 4 + 256 * 1024;
const HELPER_BOOTSTRAP = [
  "$ErrorActionPreference='Stop'",
  "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)",
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
  "try {",
  "$envelope=[Console]::In.ReadToEnd() | ConvertFrom-Json",
  "Add-Type -ReferencedAssemblies @('System.Drawing','UIAutomationClient','UIAutomationTypes','WindowsBase','System.Web.Extensions') -TypeDefinition $envelope.source",
  "[Console]::WriteLine([AbotComputer]::Run($envelope.request))",
  "} catch { [Console]::WriteLine('{\"transportError\":\"windows_helper_unavailable\"}'); exit 1 }",
].join(";");

export type WindowsHelperProcessResult = Readonly<{
  status: "completed" | "aborted" | "timeout" | "spawn_failed" | "output_limit";
  stdout: string;
  spawned: boolean;
  exitCode?: number;
}>;

/** One invocation, no helper files, no child commands and no replay after interruption. */
export function runWindowsComputerHelper(input: {
  executable: string;
  source: string;
  request: NativeComputerRequest;
  signal?: AbortSignal;
  spawnProcess?: typeof spawn;
}): Promise<WindowsHelperProcessResult> {
  if (input.signal?.aborted)
    return Promise.resolve({ status: "aborted", stdout: "", spawned: false });
  const payload = JSON.stringify({ source: input.source, request: JSON.stringify(input.request) });
  if (Buffer.byteLength(payload) > 512 * 1024)
    return Promise.resolve({ status: "output_limit", stdout: "", spawned: false });
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    let settled = false;
    let spawned = false;
    let status: WindowsHelperProcessResult["status"] = "completed";
    let bytes = 0;
    const chunks: Buffer[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stopGrace: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode?: number) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (stopGrace) clearTimeout(stopGrace);
      input.signal?.removeEventListener("abort", abort);
      resolve({
        status,
        stdout: status === "completed" ? Buffer.concat(chunks).toString("utf8") : "",
        spawned,
        ...(exitCode !== undefined ? { exitCode } : {}),
      });
    };
    const stop = (reason: WindowsHelperProcessResult["status"]) => {
      if (settled || status !== "completed") return;
      status = reason;
      chunks.length = 0;
      child.kill("SIGKILL");
      // WSL transport termination does not prove termination of the Windows process.
      stopGrace = setTimeout(() => finish(), 500);
      stopGrace.unref();
    };
    const abort = () => stop("aborted");
    try {
      child = (input.spawnProcess ?? spawn)(
        input.executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", HELPER_BOOTSTRAP],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch {
      status = "spawn_failed";
      finish();
      return;
    }
    child.once("spawn", () => { spawned = true; });
    child.once("error", () => { status = "spawn_failed"; finish(); });
    child.once("close", (code) => finish(code ?? undefined));
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled || status !== "completed") return;
      bytes += chunk.length;
      if (bytes > WINDOWS_HELPER_MAX_BYTES) { stop("output_limit"); return; }
      chunks.push(Buffer.from(chunk));
    });
    // Diagnostics may contain machine paths or desktop content; never project them.
    child.stderr.resume();
    child.stdin.on("error", () => stop("spawn_failed"));
    const deadline = input.request.operation === "act"
      ? input.request.deadlineEpochMs - Date.now() + 2_000
      : 25_000;
    timeout = setTimeout(() => stop("timeout"), Math.max(1, Math.min(deadline, 30_000)));
    timeout.unref();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) { abort(); return; }
    child.stdin.end(payload, "utf8");
  });
}
