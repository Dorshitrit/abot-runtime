/**
 * This function is serialized into a fresh Node process. It must remain
 * closure-free and use only node: built-ins; the starting cwd is untrusted
 * until its identity has been compared with the inherited directory handle.
 */
function directoryAuthorityBootstrap(
  mode: "task" | "command",
  messageLimit: number,
  task?: (input: unknown) => unknown,
): void {
  const fs = require("node:fs") as typeof import("node:fs");

  function fail(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
  }

  function verifyDirectoryAuthority(): void {
    const expected = fs.fstatSync(3, { bigint: true });
    const actual = fs.statSync(".", { bigint: true });
    const matchesHeldDirectory =
      expected.isDirectory() &&
      actual.isDirectory() &&
      expected.dev === actual.dev &&
      expected.ino === actual.ino;
    if (matchesHeldDirectory) return;
    fail(
      "directory_authority_changed",
      "The directory changed before the operation could establish its authority.",
    );
  }

  function readRequest(): unknown {
    const fd = mode === "task" ? 0 : 4;
    const chunk = Buffer.alloc(64 * 1024);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const length = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (length === 0) break;
      total += length;
      if (total > messageLimit) {
        fail(
          "directory_authority_request_too_large",
          "The directory operation input exceeds the bridge byte limit.",
        );
      }
      chunks.push(Buffer.from(chunk.subarray(0, length)));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  function reportFailure(error: unknown): void {
    const detail = error as {
      code?: unknown;
      message?: unknown;
      data?: unknown;
    };
    const code =
      typeof detail?.code === "string"
        ? detail.code.slice(0, 256)
        : "directory_authority_failed";
    const message =
      typeof detail?.message === "string"
        ? detail.message.slice(0, 4096)
        : "The directory operation failed.";
    let encoded: string;
    try {
      encoded = JSON.stringify({
        ok: false,
        error: { code, message, data: detail?.data },
      });
      if (Buffer.byteLength(encoded) > messageLimit) throw new Error();
    } catch {
      encoded = JSON.stringify({ ok: false, error: { code, message } });
    }
    writeResponse(mode === "task" ? 1 : 2, encoded);
    process.exitCode = mode === "task" ? 0 : 125;
  }

  function writeResponse(fd: number, encoded: string): void {
    const bytes = Buffer.from(encoded);
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    }
  }

  async function runTask(input: unknown): Promise<void> {
    if (!task)
      fail("directory_authority_failed", "The directory task is missing.");
    const result = await task(input);
    const encoded = JSON.stringify({ ok: true, result });
    if (Buffer.byteLength(encoded) > messageLimit) {
      fail(
        "directory_authority_result_too_large",
        "The directory operation result exceeds the bridge byte limit.",
      );
    }
    writeResponse(1, encoded);
  }

  function runCommand(input: unknown): void {
    const { spawn } =
      require("node:child_process") as typeof import("node:child_process");
    const command = input as { command: string; args: string[] };
    // Omitting cwd inherits the kernel-pinned authority. Resolving cwd() back
    // into a pathname here would reopen the race this bridge prevents.
    const child = spawn(command.command, command.args, {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
    child.once("error", reportFailure);
    child.once("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      if (typeof code === "number") process.exitCode = code;
    });
  }

  try {
    verifyDirectoryAuthority();
    const input = readRequest();
    if (mode === "command") {
      runCommand(input);
      return;
    }
    void runTask(input).catch(reportFailure);
  } catch (error) {
    reportFailure(error);
  }
}

export function directoryAuthorityScript(
  mode: "task" | "command",
  messageLimit: number,
  task?: (input: never) => unknown,
): string {
  const taskSource = task ? `(${task.toString()})` : "undefined";
  // tsx preserves nested function names with esbuild's __name annotation.
  // Include that annotation's definition so the same trusted task works in
  // development and in the production bundle without rewriting its source.
  const preserveFunctionName =
    "const __name=(target,value)=>Object.defineProperty(target,'name',{value,configurable:true});";
  return `${preserveFunctionName}(${directoryAuthorityBootstrap.toString()})(${JSON.stringify(mode)},${messageLimit},${taskSource});`;
}
