import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { createModelGatewayClient } from "../client.js";
import { resetDebugLoggerConfig } from "../../runtime/observability/debug-logger.js";

const PARTIAL = "Partial answer before the socket closes.";
const COMPLETE = "A subsequent request completed.";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function withinDeadline<T>(
  pending: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(() => resetDebugLoggerConfig());

test.each(["http", "package client"] as const)(
  "Ollama TCP failure after /chat content fails %s and the same gateway serves the next request",
  async (mode) => {
    const rootDir = await mkdtemp(join(tmpdir(), "abot-transport-failure-"));
    let partialResponse: ServerResponse | undefined;
    let providerCalls = 0;
    const provider = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        providerCalls += 1;
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (providerCalls === 1) {
          partialResponse = response;
          response.write(
            JSON.stringify({ message: { content: PARTIAL }, done: false }) +
              "\n",
          );
          // The client destroys this socket only after receiving the partial content.
          return;
        }
        response.end(
          JSON.stringify({
            message: { content: COMPLETE },
            done: true,
            done_reason: "stop",
          }) + "\n",
        );
      });
    });
    const providerUrl = await listen(provider);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL(
            "./__tests__/support/ollama-transport-process.ts",
            import.meta.url,
          ),
        ),
        rootDir,
        providerUrl,
      ],
      {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      },
    );
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout!.resume();
    const exited = once(child, "exit");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    try {
      const [ready] = (await withinDeadline(
        Promise.race([
          once(child, "message"),
          exited.then(([code]) => {
            throw new Error(`Gateway exited before ready: ${code} ${stderr}`);
          }),
        ]),
        5000,
        "Gateway startup timed out",
      )) as [{ type: string; origin: string; pid: number }];
      expect(ready.type).toBe("ready");
      expect(ready.pid).toBe(child.pid);
      const client = createModelGatewayClient({ baseUrl: ready.origin });
      const common = {
        agentMode: "fast" as const,
        modelStep: "supervisor.response" as const,
        abortSignal: abort.signal,
      };
      let received = "";
      let failure: unknown;
      let completed = false;
      const destroyProvider = () => {
        expect(partialResponse).toBeDefined();
        partialResponse!.destroy();
      };
      if (mode === "http") {
        const response = await fetch(ready.origin + "/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "Local failure fixture",
            modelStep: common.modelStep,
          }),
          signal: abort.signal,
        });
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let destroyed = false;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
              completed = true;
              break;
            }
            received += decoder.decode(chunk.value, { stream: true });
            if (!destroyed && received.includes(PARTIAL)) {
              destroyed = true;
              destroyProvider();
            }
          }
        } catch (error) {
          failure = error;
        }
      } else {
        try {
          await client.invoke({
            ...common,
            text: "Local failure fixture",
            onToken: (text) => {
              received += text;
              if (received === PARTIAL) destroyProvider();
            },
          });
          completed = true;
        } catch (error) {
          failure = error;
        }
      }
      expect(received).toContain(PARTIAL);
      // Check a real invocation, not merely an unrelated health route.
      const next = await client
        .invoke({ ...common, text: "Local successful fixture" })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      if ("error" in next)
        await withinDeadline(
          exited,
          1000,
          "Gateway remains alive but the subsequent request failed",
        );
      expect(child.exitCode, stderr).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(next).toMatchObject({
        value: { text: COMPLETE, meta: { terminalEventCount: 1 } },
      });
      expect(providerCalls).toBe(2);
      if (mode === "http") {
        expect(failure).toBeUndefined();
        expect(completed).toBe(true);
        expect(
          received
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual([
          { type: "content", text: PARTIAL },
          { type: "error", error: "server error" },
        ]);
      } else {
        expect(completed).toBe(false);
        expect(failure).toMatchObject({
          message: "model_stream_error: server error",
        });
      }
    } finally {
      clearTimeout(timer);
      abort.abort();
      if (child.exitCode === null && child.signalCode === null) {
        child.send("stop");
        const force = setTimeout(() => child.kill("SIGKILL"), 2000);
        await exited;
        clearTimeout(force);
      }
      await close(provider);
      await rm(rootDir, { recursive: true, force: true });
    }
  },
  15_000,
);
