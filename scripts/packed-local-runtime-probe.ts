import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

type PackedLocalRuntimeProbeOptions = {
  consumerDir: string;
  cliPath: string;
  reserveLoopbackPort: () => Promise<number>;
  waitForHttp: (
    url: string,
    child: ChildProcess,
    readOutput: () => string,
  ) => Promise<Response>;
  stopChild: (child: ChildProcess) => Promise<void>;
};

type ConsumerReply = {
  id?: number;
  value?: unknown;
  error?: string;
  ready?: boolean;
  ownership?: string;
};
type ProbeJob = {
  id: string;
  state: string;
  sessionId: string;
  prompt: string;
};

function packedConsumerSource(): string {
  return `
import { createLocalRuntimeApplication, loadRuntimeConfig } from "@abot-ai/runtime/runtime";
const config = loadRuntimeConfig({ rootDir: process.cwd(), configPath: "local/runtime.config.json", profileId: "prod" });
const application = createLocalRuntimeApplication(config);
const sessionId = "packed-local-runtime-probe";
const { scheduler, sessions } = application.services;
let scheduledEvents = 0;
application.subscribeScheduledEvents(() => { scheduledEvents += 1; });
async function command(method, jobId) {
  if (method === "create") {
    await sessions.appendMessage(sessionId, "user", "A temporary packed-package schedule probe.");
    const job = await scheduler.create({
      sessionId, title: "Packed public scheduler", prompt: "This paused future job must never run.",
      modelProfileId: "default", agentMode: "reasoning", timeZone: "UTC",
      schedule: { kind: "once", at: new Date(Date.now() + 86400000).toISOString() },
    });
    return scheduler.pause(job.id);
  }
  if (method === "inspect") return { job: await scheduler.get(jobId), runs: await scheduler.listRuns(), scheduledEvents };
  if (method === "cancel") return scheduler.cancel(jobId);
  if (method === "delete") { await sessions.deleteSession(sessionId); return scheduler.list(); }
  throw new Error("unknown_packed_probe_command");
}
process.on("message", ({ id, method, jobId }) => {
  void command(method, jobId).then(
    (value) => process.send?.({ id, value }),
    (error) => process.send?.({ id, error: String(error) }),
  );
});
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  try { await application.stop(); } finally { process.exit(0); }
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
try {
  await application.start();
  process.send?.({ ready: true, ownership: application.getOwnership() });
} catch (error) {
  process.send?.({ ready: true, error: String(error) });
}
`;
}

function consumerEnvironment(consumerDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LLM_RUNTIME_CONFIG_FILE: join(consumerDir, "local/runtime.config.json"),
    LLM_RUNTIME_PROFILE: "prod",
    LLM_RUNTIME_WEB_ENVIRONMENT: "prod",
    LLM_RUNTIME_WEB_BACKEND: "local",
  };
}

function startPackedConsumer(workerPath: string, consumerDir: string) {
  const processHandle = spawn(process.execPath, [workerPath], {
    cwd: consumerDir,
    env: consumerEnvironment(consumerDir),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  let sequence = 0;
  processHandle.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  processHandle.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });

  function waitForReply(
    matches: (reply: ConsumerReply) => boolean,
  ): Promise<ConsumerReply> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          fail(new Error(`packed local Runtime consumer timed out\n${output}`)),
        10_000,
      );
      const onExit = () =>
        fail(
          new Error(`packed local Runtime consumer exited early\n${output}`),
        );
      const onError = (error: Error) => fail(error);
      const cleanup = () => {
        clearTimeout(timeout);
        processHandle.off("message", onMessage);
        processHandle.off("exit", onExit);
        processHandle.off("error", onError);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onMessage = (message: ConsumerReply) => {
        if (!matches(message)) return;
        cleanup();
        if (message.error) {
          reject(new Error(message.error));
          return;
        }
        resolve(message);
      };
      processHandle.on("message", onMessage);
      processHandle.once("exit", onExit);
      processHandle.once("error", onError);
    });
  }

  return {
    process: processHandle,
    ready: waitForReply((reply) => reply.ready === true),
    async call<T>(method: string, jobId?: string): Promise<T> {
      const id = ++sequence;
      const reply = waitForReply((message) => message.id === id);
      processHandle.send({ id, method, jobId });
      return (await reply).value as T;
    },
  };
}

export async function runPackedLocalRuntimeProbe(
  options: PackedLocalRuntimeProbeOptions,
): Promise<void> {
  const { consumerDir, cliPath, reserveLoopbackPort, waitForHttp, stopChild } =
    options;
  const workerPath = join(consumerDir, "packed-local-runtime.mjs");
  await writeFile(workerPath, packedConsumerSource(), "utf-8");
  const children = new Set<ChildProcess>();
  try {
    const owner = startPackedConsumer(workerPath, consumerDir);
    children.add(owner.process);
    assert.equal(
      (await owner.ready).ownership,
      "owner",
      "first public managed application must own the environment",
    );
    const client = startPackedConsumer(workerPath, consumerDir);
    children.add(client.process);
    assert.equal(
      (await client.ready).ownership,
      "client",
      "second public managed application must attach to the existing owner",
    );
    const job = await client.call<ProbeJob>("create");
    assert.equal(job.state, "paused");
    assert.deepEqual(
      (await owner.call<{ job: ProbeJob }>("inspect", job.id)).job,
      job,
    );

    const [webPort, gatewayPort] = await Promise.all([
      reserveLoopbackPort(),
      reserveLoopbackPort(),
    ]);
    let webOutput = "";
    const web = spawn(process.execPath, [cliPath, "start"], {
      cwd: consumerDir,
      env: {
        ...consumerEnvironment(consumerDir),
        LLM_RUNTIME_WEB_HOST: "127.0.0.1",
        LLM_RUNTIME_WEB_PORT: String(webPort),
        PORT: String(gatewayPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(web);
    web.stdout?.on("data", (chunk) => {
      webOutput += String(chunk);
    });
    web.stderr?.on("data", (chunk) => {
      webOutput += String(chunk);
    });
    const baseUrl = `http://127.0.0.1:${webPort}`;
    await waitForHttp(`${baseUrl}/web-health`, web, () => webOutput);
    const response = await fetch(
      `${baseUrl}/web-api/schedules/${encodeURIComponent(job.id)}?environment=prod`,
    );
    assert.equal(
      response.status,
      200,
      `packaged Web must read the existing local owner's Job: ${await response.clone().text()}`,
    );
    assert.deepEqual(((await response.json()) as { job: ProbeJob }).job, job);
    for (const asset of [
      "/lib/schedule-errors.js",
      "/components/schedules/workspace-state.js",
      "/styles/38-schedule-workspace.css",
    ]) {
      const assetResponse = await fetch(`${baseUrl}${asset}`);
      assert.equal(
        assetResponse.status,
        200,
        `packaged Web asset missing: ${asset}`,
      );
      assert.ok(
        assetResponse.headers
          .get("content-type")
          ?.includes(asset.endsWith(".css") ? "text/css" : "javascript"),
        `packaged Web served the wrong content type for ${asset}`,
      );
      assert.ok(
        (await assetResponse.text()).trim().length > 0,
        `packaged Web asset empty: ${asset}`,
      );
    }

    await stopChild(client.process);
    children.delete(client.process);
    await stopChild(web);
    children.delete(web);
    const afterDetach = await owner.call<{
      job: ProbeJob;
      runs: unknown[];
      scheduledEvents: number;
    }>("inspect", job.id);
    assert.deepEqual(
      afterDetach.job,
      job,
      "client and Web shutdown must not stop the owner",
    );
    assert.deepEqual(
      afterDetach.runs,
      [],
      "packed consumer probe must not execute a Job",
    );
    assert.equal(afterDetach.scheduledEvents, 0);
    assert.equal(
      (await owner.call<ProbeJob>("cancel", job.id)).state,
      "cancelled",
    );
    assert.deepEqual(await owner.call("delete"), []);
  } finally {
    await Promise.all([...children].map((child) => stopChild(child)));
    await rm(workerPath, { force: true });
  }
}
