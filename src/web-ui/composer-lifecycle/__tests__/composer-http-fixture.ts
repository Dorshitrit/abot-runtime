import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebClientStateRoutes } from "../../client-state/routes.js";
import { composerProductFixture } from "./composer-product-fixture.js";

type Mutation = Record<string, any>;
export async function composerHttpFixture(options: {
  beforeMutation?: (input: Mutation) => Promise<Response | void>;
  afterMutation?: (input: Mutation, response: Response) => Promise<void>;
  chat?: (input: Mutation) => Promise<Response>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "abot-composer-http-"));
  const routes = new WebClientStateRoutes(root);
  const messages: Mutation[] = [];
  const mutations: Mutation[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/web-ui-state") { void routes.handle(request, response, request.url); return; }
    void (async () => {
      const buffers = [];
      for await (const part of request) buffers.push(Buffer.from(part));
      const input = JSON.parse(Buffer.concat(buffers).toString());
      messages.push(input);
      const result = await options.chat?.(input) ?? Response.json({ requestId: `accepted-${messages.length}` });
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(await result.text());
    })().catch(() => { response.writeHead(500); response.end('{}'); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture listener");
  const origin = `http://127.0.0.1:${address.port}`;
  const fetchImpl: typeof fetch = async (url, input) => {
    const mutation = String(url) === "/web-ui-state" && input?.body ? JSON.parse(String(input.body)) : null;
    if (mutation) {
      mutations.push(mutation);
      const refusal = await options.beforeMutation?.(mutation);
      if (refusal) return refusal;
    }
    const result = await fetch(origin + String(url), input);
    if (mutation) await options.afterMutation?.(mutation, result);
    return result;
  };
  const f = await composerProductFixture({ fetchImpl });
  return { ...f, messages, mutations, origin,
    anotherWindow: () => composerProductFixture({ fetchImpl }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
