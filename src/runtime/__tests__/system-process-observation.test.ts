import { EventEmitter } from "node:events";
import { beforeEach, expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { runSystemProcess } from "../../computer-access/process-runner.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function mockChild(pid?: number) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    kill: vi.fn(),
  });
}
beforeEach(() => vi.mocked(spawn).mockReset());

test("only a successful spawn event records the helper executable and runtime PID", async () => {
  const child = mockChild(321);
  // Fake child events exercise the adapter; no native process is created.
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ReturnType<typeof spawn>,
  );
  const input = {
    executable: "/observed/powershell.exe",
    args: ["--command", "application start"],
    cwd: "/runtime/cwd",
  };
  const pending = runSystemProcess(input);
  child.emit("spawn");
  child.stdout.emit("data", "native command evidence");
  child.emit("close", 0);
  const result = await pending;
  expect(result).toMatchObject({
    status: "completed",
    exitCode: 0,
    stdout: "native command evidence",
    spawnedProcess: {
      pid: 321,
      pidNamespace: "runtime_os",
      executable: input.executable,
      identitySource: "spawn_arguments",
    },
  });
  expect(result.spawnedProcess).not.toHaveProperty("args");
  expect(result.spawnedProcess).not.toHaveProperty("applicationPid");
  expect(spawn).toHaveBeenCalledExactlyOnceWith(
    input.executable,
    input.args,
    expect.objectContaining({ cwd: input.cwd }),
  );
});

test("spawn failure has no observed process identity even if a mock exposes a PID", async () => {
  const child = mockChild(654);
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ReturnType<typeof spawn>,
  );
  const pending = runSystemProcess({ executable: "/missing/helper", args: [] });
  child.emit("error", new Error("ENOENT"));
  const result = await pending;
  expect(result).toMatchObject({
    status: "spawn_failed",
    exitCode: null,
    stderr: "ENOENT",
  });
  expect(result).not.toHaveProperty("spawnedProcess");
});

test("a transport that does not report a PID cannot invent process identity", async () => {
  const child = mockChild();
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ReturnType<typeof spawn>,
  );
  const pending = runSystemProcess({
    executable: "/observed/helper",
    args: [],
  });
  child.emit("spawn");
  child.emit("close", 0);
  const result = await pending;
  expect(result).toMatchObject({ status: "completed", exitCode: 0 });
  expect(result).not.toHaveProperty("spawnedProcess");
});
