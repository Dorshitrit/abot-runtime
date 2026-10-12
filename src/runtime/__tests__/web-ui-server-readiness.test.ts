import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { waitForWebUiListening } from "../../web-ui/server-readiness.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (!server.listening) continue;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
function server() {
  const instance = createServer((_req, res) => res.end("ready"));
  servers.push(instance);
  return instance;
}
it("reports the actual ephemeral listener and removes readiness listeners", async () => {
  const instance = server();
  const initialListeners = instance.listenerCount("listening");
  const ready = waitForWebUiListening(instance, new AbortController().signal);
  instance.listen(0, "127.0.0.1");
  const address = await ready;
  expect(new URL(address).port).not.toBe("0");
  expect(await (await fetch(address)).text()).toBe("ready");
  expect(instance.listenerCount("listening")).toBe(initialListeners);
  expect(instance.listenerCount("error")).toBe(0);
  await expect(
    waitForWebUiListening(instance, new AbortController().signal),
  ).resolves.toBe(address);
});
it("rejects an occupied port instead of reporting another workspace ready", async () => {
  const first = server();
  const firstReady = waitForWebUiListening(first, new AbortController().signal);
  first.listen(0, "127.0.0.1");
  const url = new URL(await firstReady);
  const second = server();
  const failed = expect(
    waitForWebUiListening(second, new AbortController().signal),
  ).rejects.toMatchObject({ code: "EADDRINUSE" });
  second.listen(Number(url.port), "127.0.0.1");
  await failed;
});
it("rejects closing before listening and cleans up its listeners", async () => {
  const instance = server();
  const initialListeners = instance.listenerCount("listening");
  const controller = new AbortController();
  const failed = expect(
    waitForWebUiListening(instance, controller.signal),
  ).rejects.toThrow("closed_before_listening");
  controller.abort();
  await failed;
  expect(instance.listenerCount("listening")).toBe(initialListeners);
  expect(instance.listenerCount("error")).toBe(0);
  await expect(
    waitForWebUiListening(instance, controller.signal),
  ).rejects.toThrow("closed_before_listening");
});
