import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { LocalRuntimeWebBackend } from "../../../web-ui/local-runtime-backend.js";
import { createModelSetupFixture } from "./model-setup-fixture.js";

export async function createInputValidationFixture() {
  const fixture = await createModelSetupFixture(
    ".codex/artifacts/abot170-qa-fixes/inputs",
  );
  const backend = new LocalRuntimeWebBackend({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    defaultEnvironmentId: "prod",
  });
  const server = createServer((request, response) => {
    void backend.handleHttp(
      request,
      response,
      new URL(request.url!, "http://localhost").pathname,
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    ...fixture,
    origin,
    request(
      method: string,
      route: string,
      body?: string,
      headers: Record<string, string> = {},
    ) {
      return fetch(`${origin}/web-api/${route}`, {
        method,
        headers: { "content-type": "application/json", origin, ...headers },
        ...(body === undefined ? {} : { body }),
      });
    },
    async cleanup() {
      await backend.stop();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      await fixture.cleanup();
    },
  };
}

export async function inputFixtureFileHashes(
  rootDir: string,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await collect(path);
        continue;
      }
      hashes[relative(rootDir, path)] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    }
  }
  await collect(rootDir);
  return hashes;
}

export type InputValidationFixture = Awaited<
  ReturnType<typeof createInputValidationFixture>
>;
