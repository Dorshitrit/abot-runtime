import { expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { runSystemProcess } from "../../../plugins/system/source/process-runner.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    throw new Error("Unexpected native process spawn");
  }),
}));

test("an already-aborted native system request never spawns a subprocess", async () => {
  const abort = new AbortController();
  abort.abort();
  const result = await runSystemProcess({
    executable: "/must-not-run/native-helper",
    args: ["--mutate"],
    abortSignal: abort.signal,
  });
  expect(spawn).not.toHaveBeenCalled();
  expect(result).toEqual({
    status: "aborted",
    exitCode: null,
    stdout: "",
    stderr: "",
    outputTruncated: false,
  });
});
