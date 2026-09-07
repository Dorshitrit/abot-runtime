import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { createLocalRuntimeApplication } from "../../local-application.js";
import { createLocalRuntimeOwner } from "../../local-host/app-owner.js";
import { resolveLocalRuntimeIdentity } from "../../local-host/client-identity.js";
import { createLocalRuntimeConnection } from "../../local-host/transport.js";
import type { RuntimeConfig } from "../../ports.js";
import type {
  CreateSchedulerJobInput,
  SchedulerRun,
} from "../../scheduler/contracts.js";
import {
  createSchedulerRuntimeFixture,
  SCHEDULED_PROMPT,
  type ScheduledModelInput,
} from "./scheduler-runtime-fixture.js";

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export async function startLocalRuntimeChild(config: RuntimeConfig) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(
        new URL("./local-runtime-client-child.ts", import.meta.url),
      ),
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const pending = new Map<string, PendingCommand>();
  const events: { source: string; event: Record<string, unknown> }[] = [];
  let sequence = 0;
  let stderr = "";
  let exited = false;
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout!.resume();
  child.on(
    "message",
    (message: {
      id?: string;
      value?: unknown;
      error?: string;
      source?: string;
      event?: Record<string, unknown>;
    }) => {
      if (message.event) {
        events.push({ source: message.source!, event: message.event });
        return;
      }
      const command = pending.get(message.id!);
      if (!command) return;
      pending.delete(message.id!);
      clearTimeout(command.timer);
      if (message.error) command.reject(new Error(message.error));
      else command.resolve(message.value);
    },
  );
  const exit = new Promise<void>((resolve) =>
    child.once("exit", (code) => {
      exited = true;
      for (const command of pending.values()) {
        clearTimeout(command.timer);
        command.reject(new Error(`local_runtime_child_exit:${code}:${stderr}`));
      }
      pending.clear();
      resolve();
    }),
  );
  child.once("error", (error) => {
    for (const command of pending.values()) {
      clearTimeout(command.timer);
      command.reject(error);
    }
    pending.clear();
  });
  function call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    if (!child.connected)
      return Promise.reject(new Error("local_runtime_child_disconnected"));
    const id = String(++sequence);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`local_runtime_child_timeout:${method}:${stderr}`));
      }, 10_000);
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      child.send({ id, method, args });
    });
  }
  async function stop() {
    if (exited) return;
    try {
      if (child.connected) await call("stop");
    } finally {
      const deadline = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exit;
      clearTimeout(deadline);
    }
  }
  try {
    const ready = await call<{ ownership: string; pid: number }>(
      "init",
      config,
    );
    return { call, events, ready, stop };
  } catch (error) {
    child.kill("SIGKILL");
    await exit;
    throw error;
  }
}

export async function createLocalRuntimeProcessFixture(
  beforeModel?: (input: ScheduledModelInput) => Promise<void>,
  runtimeId?: string,
) {
  const scripted = await createSchedulerRuntimeFixture(
    "supervisor-worker-v1",
    beforeModel,
  );
  await scripted.application.stop();
  if (runtimeId) scripted.config.runtimeId = runtimeId;
  const owner = await createLocalRuntimeConnection({
    directory: join(scripted.config.paths.runtimeDir, "local-host"),
    identity: resolveLocalRuntimeIdentity(scripted.config),
    createOwner: () =>
      createLocalRuntimeOwner(scripted.config, {
        models: { invoke: scripted.invoke, invokeRaw: scripted.invokeRaw },
      }),
  });
  const observer = createLocalRuntimeApplication(scripted.config);
  const events: Record<string, unknown>[] = [];
  observer.subscribeScheduledEvents((event) => events.push(event));
  await observer.start();
  const children: Awaited<ReturnType<typeof startLocalRuntimeChild>>[] = [];
  return {
    config: scripted.config,
    invoke: scripted.invoke,
    owner,
    observer,
    events,
    async child() {
      const child = await startLocalRuntimeChild(scripted.config);
      children.push(child);
      return child;
    },
    async waitForRun(runId: string): Promise<SchedulerRun> {
      let settled: SchedulerRun | undefined;
      await vi.waitFor(
        async () => {
          const run = (await observer.services.scheduler.listRuns()).find(
            (entry) => entry.id === runId,
          );
          if (!run || run.status === "running" || run.status === "pending")
            throw new Error("run_not_settled");
          settled = run;
        },
        { timeout: 5000, interval: 10 },
      );
      return settled!;
    },
    async dispose() {
      try {
        await Promise.all(children.map((child) => child.stop()));
      } finally {
        try {
          await observer.stop();
          await owner.close();
        } finally {
          await scripted.dispose();
        }
      }
    },
  };
}

export function localRuntimeJobInput(): CreateSchedulerJobInput {
  return {
    sessionId: "session",
    title: "Across processes",
    prompt: SCHEDULED_PROMPT,
    modelProfileId: "scheduled-model",
    agentMode: "deep",
    timeZone: "Asia/Jerusalem",
    schedule: { kind: "timer", delayMs: 3_600_000 },
  };
}
