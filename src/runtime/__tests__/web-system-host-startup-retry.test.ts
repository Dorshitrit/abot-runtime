import { createServer } from "node:http";
import { expect, test } from "vitest";
import { WebSystemHostService } from "../../web-ui/system-host-service.js";
import { hostCompanionFixture } from "./support/host-companion-fixture.js";

test("retries broker startup after the previous process releases ownership", async () => {
  const owner = await hostCompanionFixture();
  const competing = new WebSystemHostService(owner.rootDir);
  const server = createServer((request, response) => {
    void competing.handleHttp(
      request,
      response,
      "/web-api/runtime/system-host",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const revoke = () =>
    fetch(`http://127.0.0.1:${port}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  try {
    await owner.pair();
    const rejected = await revoke();
    expect(rejected.status).toBe(503);
    await rejected.arrayBuffer();
    await owner.restart();
    const recovered = await revoke();
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      paired: false,
      connected: false,
    });
  } finally {
    await competing.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await owner.close();
  }
});
