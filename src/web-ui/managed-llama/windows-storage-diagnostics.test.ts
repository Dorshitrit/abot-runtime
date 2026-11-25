import { channel } from "node:diagnostics_channel";
import { afterEach, expect, test } from "vitest";
import { publishWindowsStorageFailure } from "./windows-storage-diagnostics.js";
import type { WindowsStorageAccess } from "./windows-storage.js";

const failures = channel("abot.managed-llama.windows-storage-failure");
const observed: unknown[] = [];
const collect = (value: unknown) => { observed.push(value); };
afterEach(() => { failures.unsubscribe(collect); observed.length = 0; });

test.each([
  { fields: { killed: true, signal: "SIGTERM", code: null }, elapsed: 10_008, kind: "timeout" },
  { fields: { killed: true, signal: "SIGTERM", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, elapsed: 10_008, kind: "output-limit" },
  { fields: { code: "ENOENT" }, elapsed: 4, kind: "spawn" },
  { fields: { code: "EACCES" }, elapsed: 4, kind: "spawn" },
  { fields: { code: 1 }, elapsed: 800, kind: "process-exit" },
  { fields: { killed: true, signal: "SIGTERM", code: null }, elapsed: 800, kind: "unknown" },
])("classifies $kind without retaining child diagnostics", ({ fields, elapsed, kind }) => {
  failures.subscribe(collect);
  const secret = "private-path-and-credential-canary";
  const error = Object.assign(new Error(secret), fields, {
    path: secret, cmd: secret, stdout: secret, stderr: secret, apiKey: secret,
  });
  publishWindowsStorageFailure(error, "create-file", elapsed, 10_000);
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({ kind, access: "create-file", elapsedMs: elapsed });
  expect(JSON.stringify(observed)).not.toContain(secret);
});

test("only emits bounded known fields from arbitrary failures", () => {
  failures.subscribe(collect);
  publishWindowsStorageFailure({ code: "secret-code", signal: "secret-signal", killed: "secret", other: "secret" },
    "secret-access" as WindowsStorageAccess, Number.NaN, 10_000);
  expect(observed).toEqual([{ kind: "unknown", access: "unknown", elapsedMs: 0 }]);
  expect(Object.isFrozen(observed[0])).toBe(true);
});

test("preserves only an allowlisted process signal and numeric exit code", () => {
  failures.subscribe(collect);
  publishWindowsStorageFailure({ code: 5, signal: "SIGKILL" }, "private", 15.4, 10_000);
  expect(observed).toEqual([{ kind: "process-exit", access: "private", elapsedMs: 15, signal: "SIGKILL", exitCode: 5 }]);
});

test("does not evaluate error fields when nobody subscribes", () => {
  const error = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("unexpected inspection"); } });
  expect(() => publishWindowsStorageFailure(error, "path", 5, 10_000)).not.toThrow();
});

test("does not evaluate error field getters", () => {
  failures.subscribe(collect);
  const error = { get code() { throw new Error("unexpected getter"); } };
  publishWindowsStorageFailure(error, "path", 5, 10_000);
  expect(observed).toEqual([{ kind: "unknown", access: "path", elapsedMs: 5 }]);
});

test("unobservable proxy fields cannot replace the storage failure", () => {
  failures.subscribe(collect);
  const error = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("private proxy detail"); } });
  expect(() => publishWindowsStorageFailure(error, "private", 5, 10_000)).not.toThrow();
  expect(observed).toEqual([{ kind: "unknown", access: "private", elapsedMs: 5 }]);
});

test.each([true, false])("reports killed=%s even without a confirmed timeout signal", killed => {
  failures.subscribe(collect);
  publishWindowsStorageFailure({ killed, signal: null, code: null }, "private", 10_008, 10_000);
  expect(observed).toEqual([{ kind: "unknown", access: "private", elapsedMs: 10_008, killed }]);
});
