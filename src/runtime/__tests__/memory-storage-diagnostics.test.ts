import { channel } from "node:diagnostics_channel";
import * as fs from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import createMemoryPlugin from "../../../plugins/memory/source/index.js";
import { MEMORY_STORAGE_FAILURE_CHANNEL, reportMemoryStorageFailure } from "../../../plugins/memory/source/storage-diagnostics.js";
import { createPortablePluginFixture, removePortablePluginFixtures } from "./windows-portable-plugins-fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, access: vi.fn(actual.access) };
});

const failures = channel(MEMORY_STORAGE_FAILURE_CHANNEL);
const listeners: Array<(event: unknown) => void> = [];
function collectFailures() {
  const events: unknown[] = [];
  const collect = (event: unknown) => { events.push(event); };
  listeners.push(collect);
  failures.subscribe(collect);
  return events;
}

afterEach(async () => {
  listeners.splice(0).forEach((listener) => failures.unsubscribe(listener));
  vi.mocked(fs.access).mockReset();
  await removePortablePluginFixtures();
});

test("storage diagnostics contain only stage and allowlisted filesystem identifiers", () => {
  const events = collectFailures();
  reportMemoryStorageFailure("lock-observe", Object.assign(new Error("SECRET_MEMORY"), {
    code: "EPERM", syscall: "lstat", path: "SECRET_PATH", dest: "SECRET_DEST",
    stdout: "SECRET_OUTPUT", stderr: "SECRET_ERROR", cause: new Error("SECRET_CAUSE"),
  }));
  expect(events).toEqual([{ stage: "lock-observe", code: "EPERM", syscall: "lstat" }]);
  expect(Object.isFrozen(events[0])).toBe(true);
});

test("unknown or hostile error fields cannot escape into diagnostics", () => {
  const events = collectFailures();
  reportMemoryStorageFailure("lock-install", { code: "SECRET_CODE", syscall: "SECRET_CALL" });
  reportMemoryStorageFailure("read", { get code() { throw new Error("SECRET_GETTER"); } });
  reportMemoryStorageFailure("read", null);
  expect(events).toEqual([
    { stage: "lock-install", code: "unknown", syscall: "unknown" },
    { stage: "read", code: "unknown", syscall: "unknown" },
    { stage: "read", code: "unknown", syscall: "unknown" },
  ]);
});

test("unsubscribed diagnostics do not inspect the error", () => {
  const readCode = vi.fn(() => "EACCES");
  reportMemoryStorageFailure("read", { get code() { return readCode(); } });
  expect(readCode).not.toHaveBeenCalled();
});

test("a real plugin failure retains its safe public result while internal diagnostics identify the failed access", async () => {
  const context = await createPortablePluginFixture("memory");
  const events = collectFailures();
  vi.mocked(fs.access).mockRejectedValueOnce(Object.assign(new Error("SECRET_NATIVE_DETAIL"), {
    code: "EACCES", syscall: "access", path: "SECRET_PATH",
  }));
  const result = await createMemoryPlugin(context).handlers.memory_add!({ content: "SECRET_MEMORY" });
  expect(result).toMatchObject({ ok: false, errorCode: "memory_store_unavailable", error: "Memory store is unavailable." });
  expect(events).toEqual([{ stage: "initialize-access", code: "EACCES", syscall: "access" }]);
  expect(JSON.stringify(result)).not.toContain("SECRET");
});
