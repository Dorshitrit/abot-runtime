import { execFile } from "node:child_process";
import { chmod, readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import * as atomicWrite from "../../../plugins/filesystem/source/atomic-write.js";
import { eaFixture } from "./support/filesystem-ea-fixture.js";

const fixtures: Awaited<ReturnType<typeof eaFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

async function setup() {
  const fixture = await eaFixture(); fixtures.push(fixture);
  const request = await fixture.request();
  const file = join(fixture.paths.agentWorkDir, "text.txt");
  await writeFile(file, "old\n");
  const time = new Date("2020-01-01T00:00:00Z");
  await utimes(file, time, time);
  const read = await request.port.execute({ tool: "read_text", params: { path: "text.txt" } });
  expect(read.ok).toBe(true);
  const controls = { path: "text.txt", range_ref: read.data?.range_ref };
  const projection = request.executor.operations.find((entry) => entry.operation.operationId === "edit_text")!;
  return { fixture, request, file, controls, projection, time };
}

async function changeExtendedAttribute(file: string) {
  const before = await stat(file, { bigint: true });
  await promisify(execFile)("/usr/bin/xattr", ["-w", "ai.abot.issue402-test", "metadata-only", file]);
  const after = await stat(file, { bigint: true });
  expect(after.ctimeNs).not.toBe(before.ctimeNs);
  expect(after.mtimeNs).toBe(before.mtimeNs);
  expect(after.ino).toBe(before.ino);
  expect(await readFile(file, "utf8")).toBe("old\n");
}

test.skipIf(process.platform !== "darwin").each(["read", "authoring", "prepared"])(
  "a real xattr change after %s does not invalidate unchanged source", async (phase) => {
    const { request, file, controls, projection } = await setup();
    if (phase === "read") await changeExtendedAttribute(file);
    const source = await projection.preparePayload!(controls);
    expect(source.context.sourceText).toBe("old\n");
    if (phase === "authoring") await changeExtendedAttribute(file);
    const prepared = await request.executor.prepare({ handle: projection.handle, controls, payload: source.bind("new\n") });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("expected_prepared");
    if (phase === "prepared") await changeExtendedAttribute(file);
    expect(await prepared.execute()).toMatchObject({ result: { ok: true } });
    expect(await readFile(file, "utf8")).toBe("new\n");
  },
);

test("timestamp-only changes preserve restored ranges and pending approval fingerprints", async () => {
  const { fixture, request, file, controls } = await setup();
  const originalState = request.state.snapshot();
  await utimes(file, new Date(), new Date());
  const pending = await fixture.request({ state: originalState, permission: "ask" });
  const { prepared } = await pending.prepareBody("edit_text", controls, "approved\n");
  const saved = pending.state.snapshot();
  await utimes(file, new Date("2021-01-01"), new Date("2021-01-01"));
  const restored = await fixture.request({ state: saved, permission: "ask" });
  const resumed = await restored.executor.restore(prepared.snapshot);
  expect(resumed.status).toBe("prepared");
  if (resumed.status !== "prepared") throw new Error("expected_prepared");
  expect(resumed.actionFingerprint).toBe(prepared.actionFingerprint);
  expect(restored.state.snapshot()).toEqual(saved);
  resumed.applyApprovalDecision({ approvalId: resumed.approvalRequest!.approvalId,
    actionFingerprint: resumed.actionFingerprint, decision: { approved: true } });
  expect(await resumed.execute()).toMatchObject({ result: { ok: true } });
  expect(await readFile(file, "utf8")).toBe("approved\n");
});

test.each(["read", "authoring", "prepared"])(
  "same-length content drift after %s is rejected even with restored mtime", async (phase) => {
    const { request, file, controls, projection, time } = await setup();
    const overwrite = async () => {
      await writeFile(file, "evil");
      await utimes(file, time, time);
      expect((await stat(file)).mtime.getTime()).toBe(time.getTime());
    };
    if (phase === "read") {
      await overwrite();
      await expect(projection.preparePayload!(controls)).rejects.toMatchObject({
        code: "filesystem_target_changed",
        message: "The file changed after the range was read. Read it again.",
      });
      expect(await readFile(file, "utf8")).toBe("evil");
      return;
    }
    const source = await projection.preparePayload!(controls);
    if (phase === "authoring") await overwrite();
    const prepared = await request.executor.prepare({ handle: projection.handle, controls, payload: source.bind("new\n") });
    if (phase === "authoring") {
      expect(prepared).toMatchObject({
        status: "rejected", code: "filesystem_target_changed",
        message: "The target changed after payload preparation. Read it again.",
      });
      expect(await readFile(file, "utf8")).toBe("evil");
      return;
    }
    if (prepared.status !== "prepared") throw new Error("expected_prepared");
    await overwrite();
    expect(await prepared.execute()).toMatchObject({ result: { ok: false, errorCode: "filesystem_target_changed" } });
    expect(await readFile(file, "utf8")).toBe("evil");
  },
);

test("replacement with identical bytes cannot reuse the original file reference", async () => {
  const { request, file, controls } = await setup();
  const { prepared } = await request.prepareBody("edit_text", controls, "new\n");
  const replacement = `${file}.replacement`;
  await writeFile(replacement, "old\n");
  await rename(replacement, file);
  await expect(request.prepareBody("edit_text", controls, "new\n")).rejects.toMatchObject({ code: "filesystem_target_changed" });
  expect(await prepared.execute()).toMatchObject({ result: { ok: false, errorCode: "filesystem_target_changed" } });
  expect(await readFile(file, "utf8")).toBe("old\n");
});

test.skipIf(process.platform === "win32")("lost write permission still rejects the prepared edit", async () => {
  const { request, file, controls } = await setup();
  const { prepared } = await request.prepareBody("edit_text", controls, "new\n");
  const mode = (await stat(file)).mode;
  try {
    await chmod(file, 0o400);
    expect(await prepared.execute()).toMatchObject({ result: { ok: false, errorCode: "filesystem_target_changed" } });
    expect(await readFile(file, "utf8")).toBe("old\n");
  } finally { await chmod(file, mode); }
});

test.each(["content", "metadata"])("a competing %s change at commit still trips the full race guard", async (change) => {
  const { request, file, controls } = await setup();
  const { prepared } = await request.prepareBody("edit_text", controls, "new\n");
  const write = atomicWrite.atomicWriteText;
  vi.spyOn(atomicWrite, "atomicWriteText").mockImplementation(async (input) => {
    if (change === "content") await writeFile(file, "race");
    if (change === "metadata") await utimes(file, new Date(), new Date());
    return write(input);
  });
  expect(await prepared.execute()).toMatchObject({ result: { ok: false, errorCode: "filesystem_target_changed" } });
  expect(await readFile(file, "utf8")).toBe(change === "content" ? "race" : "old\n");
});
