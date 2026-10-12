import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import { createExecProcessManager } from "../../../plugins/exec/source/process-manager.js";
import { createExecOutputStore } from "../../../plugins/exec/source/output-store.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
afterEach(removePortablePluginFixtures);
describe.skipIf(process.platform !== "win32")(
  "Windows EXEC process group lifetime",
  () => {
    test.each([
      "cancelled",
      "aborted",
      "hard_timeout",
      "idle_timeout",
      "completed",
    ] as const)(
      "%s stops ordinary descendants",
      async (reason) => {
        const context = await createPortablePluginFixture("exec");
        const script = join(context.rootDir, "heartbeat.cjs");
        const heartbeat = join(context.rootDir, "heartbeat.txt");
        const pidFile = join(context.rootDir, "child.pid");
        await writeFile(
          script,
          `const fs=require('node:fs');fs.writeFileSync('child.pid',String(process.pid));fs.appendFileSync('heartbeat.txt','ready\\n');process.stdout.write('ready\\n');setInterval(()=>fs.appendFileSync('heartbeat.txt','alive\\n'),20);`,
        );
        const command =
          reason === "completed"
            ? `Start-Process -FilePath ${quote(process.execPath)} -ArgumentList 'heartbeat.cjs' -NoNewWindow;while(-not (Test-Path -LiteralPath 'heartbeat.txt')) {Start-Sleep -Milliseconds 20}`
            : `& ${quote(process.execPath)} ${quote(script)}`;
        const manager = createExecProcessManager(
          createExecOutputStore({ stateDir: context.stateDir }),
        );
        const controller = new AbortController();
        let settled: Promise<void> | undefined;
        let snapshot: Awaited<ReturnType<typeof manager.start>> | undefined;
        let descendant: number | undefined;
        try {
          snapshot = await manager.start({
            scope: reason,
            shellCommand: command,
            cwd: context.rootDir,
            yieldAfterMs: 20,
            hardTimeoutMs: reason === "hard_timeout" ? 15_000 : 30_000,
            idleTimeoutMs: reason === "idle_timeout" ? 10_000 : 30_000,
            abortSignal: controller.signal,
            onStarted: (_id, pending) => {
              settled = pending;
            },
          });
          await expect
            .poll(() => readFile(heartbeat, "utf8").catch(() => ""), {
              timeout: 10_000,
            })
            .toContain("ready");
          descendant = Number(await readFile(pidFile, "utf8"));
          expect(descendant).toBeGreaterThan(1);
          if (reason === "cancelled")
            snapshot = await manager.cancel({
              scope: reason,
              processId: snapshot.processId,
            });
          if (reason === "aborted") controller.abort();
          await settled;
          if (reason !== "aborted") {
            if (snapshot.status === "running")
              snapshot = await manager.wait({
                scope: reason,
                processId: snapshot.processId,
                cursor: snapshot.nextCursor!,
                waitMs: 20,
              });
            expect(snapshot).toMatchObject({
              status: "settled",
              terminationReason: reason,
            });
            if (reason.endsWith("timeout")) expect(snapshot.exitCode).toBe(124);
          }
          const final = await readFile(heartbeat, "utf8");
          await delay(150);
          expect(await readFile(heartbeat, "utf8")).toBe(final);
        } finally {
          controller.abort();
          if (snapshot)
            await manager.release(snapshot.processId, reason).catch(() => {});
          if (descendant) {
            try {
              process.kill(descendant, "SIGKILL");
            } catch {}
          }
        }
      },
      40_000,
    );
  },
);
