import { access, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createExecOutputStore } from "../../../plugins/exec/source/output-store.js";
import { createExecProcessManager } from "../../../plugins/exec/source/process-manager.js";
import {
  createExecOutputFixture,
  disposeExecOutputFixtures,
  readSingleOutputOwner,
} from "./support/exec-output-fixture.js";

afterEach(disposeExecOutputFixtures);

test("retains rejected bytes and process identity through request-state restore and exclusive delivery", async () => {
  const fixture = await createExecOutputFixture();
  const first = fixture.createRequest();
  const expected = "שלום🚀".repeat(45_000);
  const result = await first.handlers.exec(
    {
      cwd: ".",
      command: `node -e 'process.stdout.write("שלום🚀".repeat(45000)); process.stderr.write("done")'`,
    },
    first.executionContext,
  );
  expect(result).toMatchObject({
    ok: false,
    errorCode: "exec_output_delivery_pending",
    data: { processId: expect.any(String), nextCursor: expect.any(Number) },
  });
  const processId = String(result.data!.processId);
  await first.resources.waitForQuiescence();
  const saved = JSON.parse(JSON.stringify(first.resources.snapshot()));
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(8000);
  expect(JSON.stringify(saved)).not.toContain("deliveryId");
  expect(JSON.stringify(saved)).not.toContain(expected);
  await first.resources.dispose();

  const { directory } = await readSingleOutputOwner(fixture.context.stateDir);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  const captures = (await readdir(directory)).filter((name) =>
    name.endsWith(".bytes"),
  );
  expect(captures).toHaveLength(2);
  const bytes = await Promise.all(
    captures.map((name) => readFile(join(directory, name))),
  );
  expect(bytes.some((body) => body.equals(Buffer.from(expected)))).toBe(true);
  for (const name of captures)
    expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);

  const second = fixture.createRequest(saved);
  const wait = {
    process_id: processId,
    cursor: Number(result.data!.nextCursor),
  };
  const cancel = { process_id: processId };
  const [delivered, competing] = await Promise.all([
    second.handlers.exec_wait(wait, second.admittedContext("exec_wait", wait)),
    second.handlers.exec_cancel(
      cancel,
      second.admittedContext("exec_cancel", cancel),
    ),
  ]);
  expect(delivered).toMatchObject({
    ok: true,
    stderr: "done",
    contextTextFields: ["stdout", "stderr"],
    data: { processId, processStatus: "completed" },
  });
  expect(delivered.stdout === expected).toBe(true);
  expect(competing).toMatchObject({
    ok: false,
    errorCode: "unknown_exec_process",
  });
  await expect(
    second.handlers.exec_wait(wait, second.executionContext),
  ).resolves.toMatchObject({
    errorCode: "unknown_exec_process",
  });
});

test("rejecting an older terminal observation cannot unlock its replacement or accepted result", async () => {
  const fixture = await createExecOutputFixture();
  const store = createExecOutputStore({ stateDir: fixture.context.stateDir });
  const manager = createExecProcessManager(store);
  const scope = "terminal-reservation";
  const original = await manager.start({
    scope,
    cwd: fixture.config.paths.agentWorkDir,
    shellCommand: "printf retained",
    yieldAfterMs: 5000,
    idleTimeoutMs: 5000,
    hardTimeoutMs: 5000,
  });
  try {
    expect(original.status).toBe("settled");
    await expect(
      manager.cancel({ processId: original.processId, scope }),
    ).rejects.toMatchObject({
      code: "unknown_exec_process",
    });
    await manager.reject(original, scope);
    const retry = await manager.wait({
      processId: original.processId,
      scope,
      cursor: original.nextCursor!,
      waitMs: 5000,
    });
    expect(retry.deliveryId).not.toBe(original.deliveryId);
    expect(retry.stdout.body).toEqual(original.stdout.body);
    await manager.reject(original, scope);
    await expect(
      manager.cancel({ processId: original.processId, scope }),
    ).rejects.toMatchObject({
      code: "unknown_exec_process",
    });
    await manager.accept(retry, scope);
    await manager.reject(retry, scope);
    await expect(
      manager.cancel({ processId: original.processId, scope }),
    ).rejects.toMatchObject({
      code: "unknown_exec_process",
    });
  } finally {
    await manager.release(original.processId, scope);
  }
});

test("an already aborted request never starts the command or creates a process receipt", async () => {
  const fixture = await createExecOutputFixture();
  const request = fixture.createRequest();
  const controller = new AbortController();
  controller.abort();
  const result = await request.handlers.exec(
    { cwd: ".", command: "printf unexpected > must-not-exist" },
    { ...request.executionContext, abortSignal: controller.signal },
  );
  expect(result.ok).toBe(false);
  expect(result.data?.processId).toBeUndefined();
  expect(request.resources.hasActiveWork()).toBe(false);
  await expect(
    access(join(fixture.config.paths.agentWorkDir, "must-not-exist")),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
});
