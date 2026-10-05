import { readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createExecOutputStore } from "../../../plugins/exec/source/output-store.js";
import {
  createExecOutputFixture,
  disposeExecOutputFixtures,
  readSingleOutputOwner,
} from "./support/exec-output-fixture.js";

const week = 7 * 24 * 60 * 60_000;
afterEach(disposeExecOutputFixtures);

test.each(["dispose", "abort"])(
  "expires closed output after %s even when not delivered",
  async (reason) => {
    const fixture = await createExecOutputFixture({ yieldAfterMs: 20 });
    const request = fixture.createRequest();
    const controller = new AbortController();
    const result = await request.handlers.exec(
      { cwd: ".", command: "printf retained; sleep 10" },
      { ...request.executionContext, abortSignal: controller.signal },
    );
    expect(result).toMatchObject({
      data: { processId: expect.any(String), processStatus: "running" },
    });
    if (reason === "abort") {
      controller.abort();
      await request.resources.waitForQuiescence();
    }
    await request.resources.dispose();
    const { record } = await readSingleOutputOwner(fixture.context.stateDir);
    expect(record.completedAt).toEqual(expect.any(Number));
    let now = record.completedAt + week - 1;
    const store = createExecOutputStore({
      stateDir: fixture.context.stateDir,
      now: () => now,
    });
    expect(await store.cleanupExpired()).toBe(0);
    now += 2;
    expect(await store.cleanupExpired()).toBe(1);
  },
);

test("an expired restored receipt retains identity and never replays its command", async () => {
  const fixture = await createExecOutputFixture();
  const request = fixture.createRequest();
  const result = await request.handlers.exec(
    {
      cwd: ".",
      command: `printf x >> executed-once; node -e 'process.stdout.write("x".repeat(350000))'`,
    },
    request.executionContext,
  );
  expect(result.errorCode).toBe("exec_output_delivery_pending");
  const saved = JSON.parse(JSON.stringify(request.resources.snapshot()));
  await request.resources.dispose();
  const restored = fixture.createRequest(saved);
  const owner = await readSingleOutputOwner(fixture.context.stateDir);
  await writeFile(
    owner.path,
    JSON.stringify({ ...owner.record, completedAt: Date.now() - week - 1000 }),
  );
  const observed = await restored.handlers.exec_wait(
    {
      process_id: String(result.data!.processId),
      cursor: Number(result.data!.nextCursor),
    },
    restored.executionContext,
  );
  expect(observed).toMatchObject({
    ok: false,
    errorCode: "exec_output_expired",
    data: { processId: result.data!.processId, outputDelivery: "expired" },
  });
  expect(
    await readFile(
      join(fixture.config.paths.agentWorkDir, "executed-once"),
      "utf8",
    ),
  ).toBe("x");
});

test("periodic cleanup removes unacknowledged output without another command", async () => {
  const fixture = await createExecOutputFixture();
  let now = 1000;
  const store = createExecOutputStore({
    stateDir: fixture.context.stateDir,
    retentionMs: 25,
    now: () => now,
  });
  const writer = await store.createWriter({
    ownerId: "periodic",
    stream: "stdout",
  });
  writer.sink.end("unacknowledged output");
  await writer.completion;
  now += 26;
  await vi.waitFor(
    async () => {
      expect(await readdir(join(fixture.context.stateDir, "output"))).toEqual(
        [],
      );
    },
    { timeout: 3000, interval: 25 },
  );
});

test("legacy incomplete metadata expires from captured bytes rather than newer snapshot metadata", async () => {
  const fixture = await createExecOutputFixture();
  const request = fixture.createRequest();
  expect(
    (
      await request.handlers.exec(
        { cwd: ".", command: "printf legacy" },
        request.executionContext,
      )
    ).ok,
  ).toBe(true);
  const owner = await readSingleOutputOwner(fixture.context.stateDir);
  await writeFile(
    owner.path,
    JSON.stringify({ ...owner.record, completedAt: null }),
  );
  const old = new Date(Date.now() - week - 1000);
  for (const name of await readdir(owner.directory)) {
    if (name.endsWith(".bytes"))
      await utimes(join(owner.directory, name), old, old);
  }
  const store = createExecOutputStore({ stateDir: fixture.context.stateDir });
  expect(await store.cleanupExpired()).toBe(1);
});
