import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createUnixNativeProcess } from "../../computer-access/computer/unix-native-process.js";
import { NATIVE_JSON_LIMIT } from "../../computer-access/computer/unix-native-results.js";
import { desktopFixture } from "./computer-plugin-fixtures.js";

function harness() {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const messages: Array<{ id: string }> = [];
  process.stdin.on("data", (chunk: Buffer) =>
    messages.push(JSON.parse(chunk.toString())),
  );
  const backend = createUnixNativeProcess({
    platform: "linux",
    file: "fake-helper",
    args: [],
    spawnProcess: vi.fn(() => process) as unknown as typeof spawn,
  });
  return { process, messages, backend };
}

/** Retain a view of the transport-owned allocation to verify erasure, not GC. */
function deliver(
  process: ReturnType<typeof harness>["process"],
  chunk: Buffer,
): Buffer {
  const concat = Buffer.concat.bind(Buffer);
  let owned: Buffer | undefined;
  const spy = vi.spyOn(Buffer, "concat").mockImplementation((list, length) => {
    const joined = concat(list, length);
    if (list.includes(chunk)) owned = joined;
    return joined;
  });
  try {
    process.stdout.emit("data", chunk);
  } finally {
    spy.mockRestore();
  }
  if (!owned)
    throw new Error("Expected the native transport buffer allocation.");
  return owned;
}

function resultLine(id: string): string {
  const { image: _image, ...metadata } = desktopFixture();
  return JSON.stringify({ type: "result", id, result: metadata });
}

describe("Unix native owned-buffer retention", () => {
  it("erases a consumed response allocation", async () => {
    const test = harness();
    try {
      const pending = test.backend.execute({ operation: "inspect" });
      await Promise.resolve();
      const owned = deliver(
        test.process,
        Buffer.from(resultLine(test.messages[0]!.id) + "\n"),
      );
      expect((await pending).desktop.binding).toBe("session:10");
      expect(owned.every((byte) => byte === 0)).toBe(true);
    } finally {
      await test.backend.close();
    }
  });

  it("copies only an unread tail and preserves newline framing across chunks", async () => {
    const test = harness();
    try {
      const pending = test.backend.execute({ operation: "inspect" });
      await Promise.resolve();
      const id = test.messages[0]!.id;
      const result = resultLine(id);
      const receipt = JSON.stringify({
        type: "dispatch",
        id,
        dispatch: { status: "not_dispatched", requestedInputCount: 0 },
      });
      const first = deliver(
        test.process,
        Buffer.from(receipt + "\n" + result.slice(0, 43)),
      );
      expect(first.every((byte) => byte === 0)).toBe(true);
      const second = deliver(
        test.process,
        Buffer.from(result.slice(43) + "\n"),
      );
      expect((await pending).desktop.binding).toBe("session:10");
      expect(second.every((byte) => byte === 0)).toBe(true);
    } finally {
      await test.backend.close();
    }
  });

  it("erases an unfinished response when the helper is terminated", async () => {
    const test = harness();
    try {
      const pending = test.backend.execute({ operation: "inspect" });
      await Promise.resolve();
      const owned = deliver(
        test.process,
        Buffer.from('{"partial":"api_key=synthetic-secret"'),
      );
      expect(owned.some((byte) => byte !== 0)).toBe(true);
      await test.backend.close();
      expect((await pending).error?.code).toBe("computer_native_closed");
      expect(owned.every((byte) => byte === 0)).toBe(true);
    } finally {
      await test.backend.close();
    }
  });

  it("erases an oversized response before releasing it", async () => {
    const test = harness();
    try {
      const pending = test.backend.execute({ operation: "inspect" });
      await Promise.resolve();
      const owned = deliver(
        test.process,
        Buffer.alloc(NATIVE_JSON_LIMIT + 1, 97),
      );
      expect((await pending).error?.code).toBe("computer_native_result_limit");
      expect(owned.every((byte) => byte === 0)).toBe(true);
    } finally {
      await test.backend.close();
    }
  });
});
