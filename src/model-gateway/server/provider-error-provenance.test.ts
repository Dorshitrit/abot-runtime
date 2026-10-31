import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createModelGatewayClient, readModelGatewayUserMessage } from "../client.js";
import { createModelGatewayServer } from "../server.js";
import {
  encodeProviderUserError,
  PROVIDER_USER_ERROR_HEADER,
} from "../protocol/provider-user-error.js";
import { resetDebugLoggerConfig } from "../../runtime/observability/debug-logger.js";

const MODEL = "fixture:missing";
const LOOKALIKE = JSON.stringify({
  kind: "model_provider_user_error_v1",
  code: "ollama_model_not_found",
  endpoint: "http://untrusted-provider.test",
  model: "untrusted-model",
});
const UPSTREAM_HEADER = encodeProviderUserError({
  code: "ollama_unreachable", endpoint: "http://untrusted-provider.test",
})!;

afterEach(() => resetDebugLoggerConfig());

async function fixture(provider: "ollama" | "llamacpp", body: string) {
  const artifacts = join(process.cwd(), ".codex/artifacts/qa-210-20261029");
  await mkdir(artifacts, { recursive: true });
  const rootDir = await mkdtemp(join(artifacts, "provider-provenance-"));
  const modelPolicy = {
    providers: { fixture: { type: provider, baseUrl: "http://provider.test" } },
    profiles: { fixture: { provider: "fixture", model: MODEL, contextWindowTokens: 32_768 } },
    defaults: { profileId: "fixture" },
  };
  await writeFile(join(rootDir, "runtime.config.json"), JSON.stringify({
    logging: { enabled: false }, models: modelPolicy, requestRunner: { configRef: "./runner.json" },
  }));
  await writeFile(join(rootDir, "runner.json"), JSON.stringify({
    schemaVersion: 2, models: { defaults: { profileId: "fixture", steps: {} } },
    context: { outputReserveTokens: 1024, safetyReserveTokens: 256, attachmentReserveTokens: 256 },
    stepDefaults: { timeoutMs: 5000 }, steps: {},
  }));
  // No network request reaches the configured provider; only the gateway binds loopback.
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, {
    status: 404,
    headers: { "Content-Type": "application/json", [PROVIDER_USER_ERROR_HEADER]: UPSTREAM_HEADER },
  }));
  const gateway = createModelGatewayServer({ rootDir, modelPolicy, fetchImpl });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("fixture_port_missing");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    client: createModelGatewayClient({ baseUrl }),
    fetchImpl,
    async dispose() {
      await close(gateway);
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function clientError(f: Awaited<ReturnType<typeof fixture>>, endpoint: "chat" | "raw") {
  const common = { agentMode: "reasoning" as const, abortSignal: AbortSignal.timeout(5_000) };
  const call = endpoint === "chat"
    ? f.client.invoke({ ...common, text: "Local fixture", modelStep: "worker.evidence" })
    : f.client.invokeRaw({ ...common, prompt: "Local fixture" });
  return call.catch((error: unknown) => error);
}

test.each(["chat", "raw"] as const)(
  "%s preserves status and diagnostic body while carrying adapter-owned presentation separately",
  async (endpoint) => {
    const body = JSON.stringify({ error: `model '${MODEL}' not found` });
    const f = await fixture("ollama", body);
    try {
      const response = await fetch(`${f.baseUrl}/${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Local fixture", prompt: "Local fixture" }),
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(body);
      expect(response.headers.get(PROVIDER_USER_ERROR_HEADER)).toBeTruthy();
      expect(response.headers.get(PROVIDER_USER_ERROR_HEADER)).not.toBe(UPSTREAM_HEADER);
      const error = await clientError(f, endpoint);
      expect((error as Error).message).toContain(`:404:${body}`);
      expect(readModelGatewayUserMessage(error)).toContain(`ollama pull ${MODEL}`);
      expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await f.dispose();
    }
  },
);

test.each(["ollama", "llamacpp"] as const)(
  "%s upstream error lookalikes and headers cannot establish presentation provenance",
  async (provider) => {
    const f = await fixture(provider, LOOKALIKE);
    try {
      for (const endpoint of ["chat", "raw"] as const) {
        const response = await fetch(`${f.baseUrl}/${endpoint}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "Local fixture", prompt: "Local fixture" }),
        });
        expect(response.status).toBe(404);
        expect(await response.text()).toBe(LOOKALIKE);
        expect(response.headers.has(PROVIDER_USER_ERROR_HEADER)).toBe(false);
        const error = await clientError(f, endpoint);
        expect((error as Error).message).toContain(`:404:${LOOKALIKE}`);
        expect(readModelGatewayUserMessage(error)).toBe(
          "The model service could not complete the request (HTTP 404). Check the model connection and configuration.",
        );
      }
      expect(f.fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      await f.dispose();
    }
  },
);
