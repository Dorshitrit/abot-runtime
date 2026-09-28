import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
const children: ChildProcess[] = [];
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGKILL");
      await ended;
    }
  for (const dispose of disposers.splice(0)) await dispose();
});
async function setup() {
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
  await fixture.application.stop();
  disposers.push(() => fixture.dispose());
  const config = join(fixture.rootDir, "owner-config.json");
  const effects = join(fixture.rootDir, "effects.txt");
  await writeFile(config, JSON.stringify(fixture.config));
  const start = (mode: string) => {
    const child = fork(
      fileURLToPath(
        new URL("./support/saved-approval-process.ts", import.meta.url),
      ),
      [config, mode, effects],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    children.push(child);
    const messages: any[] = [];
    const waiting = new Set<() => void>();
    let failure: Error | undefined;
    let stderr = "";
    child.stderr!.on("data", (data) => {
      stderr += data;
    });
    child.on("message", (message) => {
      messages.push(message);
      for (const notify of waiting) notify();
    });
    child.on("exit", (code) => {
      if (code) failure = new Error(stderr || "worker failed");
      for (const notify of waiting) notify();
    });
    return {
      child,
      async message(kind: string): Promise<any> {
        const found = () => messages.find((message) => message.kind === kind);
        if (found()) return found();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            waiting.delete(check);
            reject(new Error(stderr || "worker timeout:" + kind));
          }, 20000);
          const check = () => {
            if (!found() && !failure) return;
            clearTimeout(timer);
            waiting.delete(check);
            if (failure) reject(failure);
            else resolve(found());
          };
          waiting.add(check);
          check();
        });
      },
      async kill() {
        const ended = once(child, "exit");
        child.kill("SIGKILL");
        await ended;
      },
    };
  };
  return { start, effects };
}

test("a killed process leaves the response waiting; a fresh process resumes its exact tool once", async () => {
  const f = await setup();
  const original = f.start("park");
  expect(await original.message("parked")).toMatchObject({
    idle: true,
    result: { kind: "awaiting_approval" },
  });
  await original.kill();
  const reader = f.start("inspect");
  const snapshot = await reader.message("snapshot");
  expect(snapshot.pending).toHaveLength(1);
  expect(snapshot.session.requests[0].status).toBe("awaiting_approval");
  await expect(readFile(f.effects, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  await once(reader.child, "exit");
  const resumed = f.start("resume");
  expect(await resumed.message("decided")).toMatchObject({
    result: { accepted: true },
  });
  const finished = await resumed.message("snapshot");
  expect(finished.session.requests[0].status).toBe("completed");
  expect(await readFile(f.effects, "utf8")).toBe("effect\n");
}, 45000);

test("a killed process during tool execution is interrupted and never replays on startup", async () => {
  const f = await setup();
  const original = f.start("active");
  await original.message("executing");
  await original.kill();
  const reader = f.start("inspect");
  const result = await reader.message("snapshot");
  expect(result.pending).toEqual([]);
  expect(result.session.requests[0]).toMatchObject({
    status: "failed",
    lifecycle: { terminalCause: "request_interrupted" },
  });
  await expect(readFile(f.effects, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
}, 45000);
