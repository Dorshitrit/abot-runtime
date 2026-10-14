import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModelGatewayServer } from "../../../server.js";
import { processDebugLogger } from "../../../../runtime/observability/debug-logger.js";

const [rootDir, providerUrl] = process.argv.slice(2);
if (!rootDir || !providerUrl)
  throw new Error("Missing local fixture configuration");
const modelPolicy = {
  providers: { local: { type: "ollama", baseUrl: providerUrl } },
  profiles: {
    fixture: {
      provider: "local",
      model: "transport-fixture",
      contextWindowTokens: 32768,
    },
  },
  defaults: { profileId: "fixture" },
};
await writeFile(
  join(rootDir, "runtime.config.json"),
  JSON.stringify({
    logging: { enabled: false },
    models: modelPolicy,
    requestRunner: { configRef: "./runner.json" },
  }),
);
await writeFile(
  join(rootDir, "runner.json"),
  JSON.stringify({
    schemaVersion: 2,
    models: { defaults: { profileId: "fixture", steps: {} } },
    context: {
      outputReserveTokens: 1024,
      safetyReserveTokens: 256,
      attachmentReserveTokens: 256,
    },
    stepDefaults: { timeoutMs: 5000 },
    steps: {},
  }),
);
const gateway = createModelGatewayServer({
  rootDir,
  modelPolicy,
  fetchImpl: (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    assert.equal(
      url.origin,
      providerUrl,
      "Only the owned loopback provider is allowed",
    );
    return fetch(input, init);
  },
});
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const address = gateway.address();
if (!address || typeof address === "string")
  throw new Error("Missing fixture port");
process.send?.({
  type: "ready",
  origin: `http://127.0.0.1:${address.port}`,
  pid: process.pid,
});
// Deliberately do not intercept uncaught exceptions or unhandled rejections.
process.on("message", async (message) => {
  if (message !== "stop") return;
  await new Promise<void>((resolve) => {
    gateway.close(() => resolve());
    gateway.closeAllConnections();
  });
  await processDebugLogger.drain();
  process.disconnect?.();
});
