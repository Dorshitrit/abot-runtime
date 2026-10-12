import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RequestComputers } from "../../../plugins/system/source/computer/request-computers.js";
import { createComputerHandlers } from "../../../plugins/system/source/computer/handlers.js";
import { createUnixNativeProcess } from "../../computer-access/computer/unix-native-process.js";
import { COMPUTER_CAPABILITY } from "../../computer-access/computer/native-validation.js";
import { HOST_SECRET_PROTECTION_CAPABILITY } from "../../computer-access/companion/secret-protection-protocol.js";
import {
  companionHarness,
  companionObservation,
  acceptedDispatch,
} from "./computer-companion-fixtures.js";
import { computerRoute, desktopFixture } from "./computer-plugin-fixtures.js";

const secret = "api_key=synthetic-secret";
describe("desktop content protection at retention boundaries", () => {
  it("withholds a Companion frame before storage and keeps its accepted receipt", async () => {
    const image = Buffer.from([1, 2, 3]);
    const original = companionObservation(image, acceptedDispatch);
    const harness = companionHarness({
      ...original,
      desktop: { ...original.desktop, name: secret },
    });
    const params = { sessionId: randomUUID(), target: "windows" };
    try {
      const response = await harness.handlers.computer_execute!({
        ...params,
        request: { operation: "observe" },
      });
      expect(response.ok).toBe(true);
      expect(response.data).not.toHaveProperty("frame");
      expect(response.data?.result).toMatchObject({
        desktop: { name: "[REDACTED]" },
        dispatch: acceptedDispatch,
        error: { code: "computer_image_secret_blocked" },
      });
      expect(JSON.stringify(response)).not.toContain(secret);
      expect([...image]).toEqual([0, 0, 0]);
      const frame = await harness.handlers.computer_frame!({
        ...params,
        frameId: randomUUID(),
        offset: 0,
      });
      expect(frame.ok).toBe(false);
      expect(frame.output).toContain("computer_frame_expired");
    } finally {
      await harness.sessions.close();
    }
  });

  it("protects local SYSTEM content before media writes or binding snapshots", async () => {
    const original = desktopFixture();
    const native = {
      execute: vi.fn(async () => ({
        ...original,
        dispatch: acceptedDispatch,
        windows: [{ ...original.windows[0]!, title: secret }],
      })),
      close: vi.fn(async () => {}),
    };
    const harness = companionHarness();
    const computers = new RequestComputers(
      "/tmp",
      [computerRoute],
      harness.connection,
      () => native,
    );
    const writer = vi.fn();
    try {
      const response = await createComputerHandlers(computers)
        .computer_observe!(
        {
          desktop_ref: computers.entries[0]!.ref,
        },
        { onRequestDispose: () => {}, media: { writeImage: writer } },
      );
      expect(response.errorCode).toBe("computer_image_secret_blocked");
      expect(response.data?.dispatch).toEqual(acceptedDispatch);
      expect(response.data?.mutationEvidence).toBe(true);
      expect(writer).not.toHaveBeenCalled();
      expect(JSON.stringify(response)).not.toContain(secret);
      expect(JSON.stringify(computers.snapshot())).not.toContain(secret);
      expect([...original.image!.bytes]).toEqual([0, 0, 0]);
    } finally {
      await computers.close();
    }
    expect(native.close).toHaveBeenCalledOnce();
  });

  it("rejects a Companion missing the protection contract before calling it", async () => {
    const harness = companionHarness();
    const computers = new RequestComputers(
      "/tmp",
      [
        {
          ...harness.route,
          capabilities: [COMPUTER_CAPABILITY],
        },
      ],
      harness.connection,
    );
    try {
      expect(() => computers.backend(computers.entries[0]!)).toThrow(
        "Install the companion",
      );
      expect(harness.connection.executeHostOperation).not.toHaveBeenCalled();
    } finally {
      await computers.close();
    }
  });

  it("accepts a compliant Companion and consumes its protected producer result", async () => {
    const harness = companionHarness();
    const computers = new RequestComputers(
      "/tmp",
      [
        {
          ...harness.route,
          capabilities: [
            COMPUTER_CAPABILITY,
            HOST_SECRET_PROTECTION_CAPABILITY,
          ],
        },
      ],
      harness.connection,
    );
    try {
      const result = await computers
        .backend(computers.entries[0]!)
        .execute({ operation: "inspect" });
      expect(result).toEqual(companionObservation());
      expect(harness.native.execute).toHaveBeenCalledOnce();
    } finally {
      await computers.close();
      await harness.sessions.close();
    }
  });

  it("retains only mechanical desktop identity after a Unix helper interruption", async () => {
    const process = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const messages: Array<{ id: string }> = [];
    process.stdin.on("data", (chunk: Buffer) => {
      messages.push(JSON.parse(chunk.toString()));
    });
    const backend = createUnixNativeProcess({
      platform: "linux",
      file: "fake-helper",
      args: [],
      spawnProcess: vi.fn(() => process) as unknown as typeof spawn,
    });
    try {
      const initial = backend.execute({ operation: "inspect" });
      await Promise.resolve();
      const original = desktopFixture();
      const { image: _image, ...metadata } = original;
      process.stdout.write(
        JSON.stringify({
          type: "result",
          id: messages[0]!.id,
          result: {
            ...metadata,
            desktop: { ...metadata.desktop, name: secret },
            windows: [{ ...metadata.windows[0]!, title: secret }],
            observation: {
              ...metadata.observation!,
              accessibility: [{ role: "text", value: secret }],
            },
            imageBase64: Buffer.from([
              137, 80, 78, 71, 13, 10, 26, 10,
            ]).toString("base64"),
          },
        }) + "\n",
      );
      await initial;
      const interrupted = backend.execute({
        operation: "act",
        desktopBinding: original.desktop.binding,
        expectedGeometry: original.desktop.bounds,
        action: { kind: "press_keys", keys: ["ENTER"] },
        deadlineEpochMs: Date.now() + 10000,
      });
      await Promise.resolve();
      process.stdout.write(
        JSON.stringify({
          type: "dispatch",
          id: messages[1]!.id,
          dispatch: acceptedDispatch,
        }) + "\n",
      );
      process.emit("exit", 1);
      const result = await interrupted;
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.windows).toEqual([]);
      expect(result.observation).toBeUndefined();
      expect(result.image).toBeUndefined();
      expect(result.desktop.binding).toBe(original.desktop.binding);
      expect(result.desktop.bounds).toEqual(original.desktop.bounds);
      expect(result.dispatch).toEqual(acceptedDispatch);
    } finally {
      await backend.close();
    }
  });
});
