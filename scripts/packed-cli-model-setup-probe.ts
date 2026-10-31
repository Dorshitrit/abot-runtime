import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The fixture accepts metadata only; no installed provider is contacted by package QA. */
async function createOllamaMetadataFixture() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const route = `${request.method} ${request.url}`;
    requests.push(route);
    response.setHeader("content-type", "application/json");
    if (route !== "GET /api/tags") {
      response.writeHead(404).end(JSON.stringify({ error: "metadata requests only" }));
      return;
    }
    response.end(JSON.stringify({ models: [{ name: "consumer-local-model:latest" }] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("packed Ollama fixture did not bind TCP");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function requirePackedLabel(consumerDir: string, profileId: string, expectedLabel: string) {
  const config = JSON.parse(await readFile(join(consumerDir, "local/models", `${profileId}.config.json`), "utf8")) as { label?: unknown };
  if (config.label !== expectedLabel) throw new Error(`packed CLI did not save the ${profileId} label`);
}

export async function verifyPackedCliModelSetup(cliPath: string, consumerDir: string, packageDir: string) {
  const fixture = await createOllamaMetadataFixture();
  const run = (args: string[]) => execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: consumerDir, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  try {
    const init = await run([
      "init", "--provider", "ollama", "--model", "consumer-local-model",
      "--base-url", fixture.baseUrl, "--label", "Local QA",
    ]);
    if (init.stderr.trim()) throw new Error(`packed installed-model setup warned unexpectedly: ${init.stderr}`);
    const added = await run([
      "add-model", "--profile", "hosted", "--provider", "openai",
      "--model", "consumer-hosted-model", "--label", "Hosted QA", "--default",
    ]);
    const missing = await run([
      "add-model", "--profile", "missing-local", "--provider", "ollama",
      "--model", "consumer-missing-model",
    ]);
    if (!missing.stderr.includes("not installed")) throw new Error("packed CLI did not warn about the missing Ollama model");
    await requirePackedLabel(consumerDir, "default", "Local QA");
    await requirePackedLabel(consumerDir, "hosted", "Hosted QA");
    await requirePackedLabel(consumerDir, "missing-local", "consumer-missing-model");
    const version = await run(["--version"]);
    const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as { version?: unknown };
    if (version.stdout.trim() !== manifest.version) throw new Error("packed CLI version does not match its installed package");
    const memoryStatus = await run(["memory", "status"]);
    const receivedOnlySetupMetadata = fixture.requests.length === 2 && fixture.requests.every((route) => route === "GET /api/tags");
    if (!receivedOnlySetupMetadata) throw new Error(`packed CLI provider request boundary failed: ${fixture.requests.join(", ")}`);
    return { initOutput: init.stdout, addModelOutput: added.stdout, memoryStatusOutput: memoryStatus.stdout };
  } finally {
    await fixture.close();
  }
}
