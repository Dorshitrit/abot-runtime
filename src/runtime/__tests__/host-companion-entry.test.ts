import { PassThrough, Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { runHostCompanionEntry } from "../../cli/host-companion-entry.js";

const setup = { url: "http://abot.localhost:5184", code: "a".repeat(43) };
const cliPath = "/fixture/host-companion-bundle.mjs";
const upgradeHostId = "317ec6e1-1148-47c7-85a2-dd6acac9fbe2";

describe("standalone companion entry", () => {
  test("hands setup credentials through memory and pins the stable bundle for startup", async () => {
    const runCli = vi.fn(async () => {});
    const serialized = JSON.stringify(setup);
    await runHostCompanionEntry(["setup"], {
      cliPath,
      runCli,
      input: Readable.from([serialized.slice(0, 20), serialized.slice(20)]),
    });
    expect(runCli).toHaveBeenCalledWith(["connect", "--url", setup.url], {
      cliPath,
      pairingCode: setup.code,
    });
  });
  test.each(["run", "status", "disconnect", "uninstall"])(
    "preserves host %s startup and management invocation",
    async (command) => {
      const runCli = vi.fn(async () => {});
      await runHostCompanionEntry(["host", command], { cliPath, runCli });
      expect(runCli).toHaveBeenCalledWith([command], { cliPath });
    },
  );
  test("forwards the exact paired host identity separately from the download origin", async () => {
    const runCli = vi.fn(async () => {});
    await runHostCompanionEntry(["setup"], {
      cliPath,
      runCli,
      input: Readable.from([JSON.stringify({ ...setup, upgradeHostId })]),
    });
    expect(runCli).toHaveBeenCalledWith(["connect", "--url", setup.url], {
      cliPath,
      pairingCode: setup.code,
      upgradeHostId,
    });
  });
  test.each([
    "not-json-private-test-value",
    "null",
    JSON.stringify({ ...setup, code: "invalid" }),
    JSON.stringify({ ...setup, url: "" }),
    JSON.stringify({ ...setup, url: "x".repeat(4_097) }),
    JSON.stringify({ ...setup, credential: "unaccepted-field" }),
    JSON.stringify({ ...setup, upgradeHostId: "wrong-host-id" }),
    JSON.stringify({ ...setup, upgradeHostId: null }),
    "x".repeat(16_385),
  ])(
    "rejects malformed or oversized input without dispatch",
    async (serialized) => {
      const runCli = vi.fn(async () => {});
      await expect(
        runHostCompanionEntry(["setup"], {
          runCli,
          input: Readable.from([serialized]),
        }),
      ).rejects.toThrow();
      expect(runCli).not.toHaveBeenCalled();
    },
  );
  test("rejects command-line secrets without echoing their value", async () => {
    await expect(runHostCompanionEntry(["setup", setup.code])).rejects.toThrow(
      "Host setup accepts JSON on standard input, not arguments.",
    );
  });
  test("bounds an installer that leaves stdin open", async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const result = expect(
      runHostCompanionEntry(["setup"], { input }),
    ).rejects.toThrow("Host setup input timed out.");
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
    } finally {
      input.destroy();
      vi.useRealTimers();
    }
  });
});
