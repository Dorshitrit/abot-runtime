import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, test } from "vitest";

import { createExecProcessManager } from "../../../plugins/exec/source/process-manager.js";
import type { ExecProcessSnapshot } from "../../../plugins/exec/source/types.js";

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function requirePromptSettlement(
  pending: Promise<ExecProcessSnapshot>,
): Promise<ExecProcessSnapshot> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("The process group did not settle promptly")),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

describe("exec process-group termination", () => {
  test.each(["cancelled", "aborted", "hard_timeout", "idle_timeout"] as const)(
    "%s stops a shell descendant before returning settled evidence",
    async (reason) => {
      const root = await mkdtemp(join(tmpdir(), "exec-process-group-"));
      const heartbeatPath = join(root, "heartbeat.txt");
      const descendantPath = join(root, "descendant.pid");
      const manager = createExecProcessManager();
      const controller = new AbortController();
      const scope = `process-group-${reason}`;
      let snapshot: ExecProcessSnapshot | undefined;
      let descendantPid: number | undefined;
      const descendantScript = [
        'const fs = require("node:fs");',
        'fs.writeFileSync("descendant.pid", String(process.pid));',
        'fs.appendFileSync("heartbeat.txt", "ready\\n");',
        'process.stdout.write("descendant-ready\\n");',
        'setInterval(() => fs.appendFileSync("heartbeat.txt", "alive\\n"), 20);',
      ].join("\n");
      const shellCommand = `${quoteShellArgument(process.execPath)} -e ${quoteShellArgument(descendantScript)} & wait`;

      try {
        snapshot = await manager.start({
          scope,
          shellCommand,
          cwd: root,
          outputMaxChars: 512,
          yieldAfterMs: 10,
          idleTimeoutMs: reason === "idle_timeout" ? 400 : 5_000,
          hardTimeoutMs: reason === "hard_timeout" ? 400 : 5_000,
          abortSignal: controller.signal,
        });
        await expect
          .poll(() => readFile(heartbeatPath, "utf8").catch(() => ""), {
            timeout: 1_500,
          })
          .toContain("ready");
        const observedPid = Number(await readFile(descendantPath, "utf8"));
        expect(Number.isSafeInteger(observedPid)).toBe(true);
        expect(observedPid).toBeGreaterThan(1);
        descendantPid = observedPid;

        if (reason === "cancelled") {
          snapshot = await requirePromptSettlement(
            manager.cancel({ processId: snapshot.processId, scope }),
          );
        }
        if (reason === "aborted") {
          controller.abort();
          await expect(
            requirePromptSettlement(
              manager.wait({
                processId: snapshot.processId,
                scope,
                cursor: snapshot.nextCursor!,
                waitMs: 1_000,
              }),
            ),
          ).rejects.toMatchObject({ code: "unknown_exec_process" });
        }
        while (reason !== "aborted" && snapshot.status === "running") {
          snapshot = await requirePromptSettlement(
            manager.wait({
              processId: snapshot.processId,
              scope,
              cursor: snapshot.nextCursor!,
              waitMs: 1_000,
            }),
          );
        }

        if (reason !== "aborted") {
          expect(snapshot).toMatchObject({
            status: "settled",
            terminationReason: reason,
            exitCode: reason.endsWith("timeout") ? 124 : 130,
          });
        }
        const settledHeartbeat = await readFile(heartbeatPath, "utf8");
        await delay(100);
        expect(await readFile(heartbeatPath, "utf8")).toBe(settledHeartbeat);
      } finally {
        if (descendantPid) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // A correctly terminated descendant has already exited.
          }
        }
        if (snapshot) {
          await manager
            .cancel({ processId: snapshot.processId, scope })
            .catch(() => undefined);
          await manager.release(snapshot.processId, scope);
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
