import { createServer } from "node:http";
import { expect, test } from "vitest";
import { WebSystemHostService } from "../../web-ui/system-host-service.js";
import { hostCompanionFixture } from "./support/host-companion-fixture.js";

test("another Web process cannot revoke a live owner's connection", async () => {
  const owner = await hostCompanionFixture();
  const competing = new WebSystemHostService(owner.rootDir);
  const server = createServer((request, response) => {
    void competing.handleHttp(request, response, "/web-api/runtime/system-host");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const grant = await owner.pair();
    const socket = await owner.activate(grant);
    const port = (server.address() as { port: number }).port;
    const rejected = await fetch(`http://127.0.0.1:${port}`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(rejected.status).toBe(503);
    expect((await owner.api()).body).toMatchObject({ paired: true, connected: true, hostId: grant.hostId });
    socket.terminate();
  } finally {
    await competing.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await owner.close();
  }
});
