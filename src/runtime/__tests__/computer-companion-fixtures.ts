import { deflateSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { NativeComputerBackend, NativeComputerRequest, NativeComputerResult } from "../../computer-access/computer/native-protocol.js";
import type { SystemRequestRoute } from "../../../plugins/system/source/request-target-snapshot.js";
import type { SystemHostConnection } from "../../../plugins/system/source/host-dispatch.js";
import { CompanionComputerSessions } from "../../computer-access/computer/companion-sessions.js";

/** A valid, deterministic PNG larger than the ordinary 256 KiB companion envelope. */
export function companionImageFixture(): Buffer {
  const width = 512, height = 160, stride = width * 4 + 1;
  const pixels = Buffer.alloc(stride * height);
  let random = 0x12345678;
  for (let row = 0; row < height; row++) {
    for (let column = 1; column < stride; column++) {
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      pixels[row * stride + column] = random & 255;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
function pngChunk(name: string, payload: Buffer): Buffer {
  const type = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(payload.length); let crc = 0xffffffff;
  for (const byte of Buffer.concat([type, payload])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, type, payload, checksum]);
}

export function companionObservation(bytes?: Buffer, dispatch?: NativeComputerResult["dispatch"]): NativeComputerResult {
  const available = { supported: true, available: true };
  return {
    desktop: {
      platform: "windows", binding: "login:desktop", name: "Windows desktop", available: true,
      bounds: { x: 0, y: 0, width: 512, height: 160 },
      capabilities: { capture: available, input: available, accessibility: available, windows: available },
      targetingGuarantee: "verified_window",
    },
    windows: [], focusedWindow: "window:pid:created",
    ...(bytes ? {
      observation: { capturedAt: "2026-09-24T12:00:00.000Z", region: { x: 0, y: 0, width: 512, height: 160 }, imageWidth: 512, imageHeight: 160, accessibility: [], accessibilityTruncated: true },
      image: { mimeType: "image/png" as const, bytes },
    } : {}),
    ...(dispatch ? { dispatch } : {}),
  };
}
export const companionAct = (): NativeComputerRequest => ({
  operation: "act", desktopBinding: "login:desktop", expectedWindow: "window:pid:created",
  expectedGeometry: { x: 0, y: 0, width: 512, height: 160 },
  action: { kind: "press_keys", keys: ["CONTROL", "L"] }, deadlineEpochMs: Date.now() + 15_000,
});
export const acceptedDispatch = { status: "accepted", requestedInputCount: 4, acceptedInputCount: 4 } as const;

export function companionHarness(result: NativeComputerResult = companionObservation()) {
  const native: NativeComputerBackend = { execute: vi.fn(async () => result), close: vi.fn(async () => {}) };
  const createBackend = vi.fn(() => native);
  const resolveTarget = vi.fn(async () => ({ id: "windows", transport: "native", shell: "unused-powershell" } as const));
  const sessions = new CompanionComputerSessions("windows", createBackend, resolveTarget);
  const handlers = sessions.handlers();
  const route: Extract<SystemRequestRoute, { kind: "companion" }> = {
    kind: "companion", target: "windows", hostId: randomUUID(), connectionId: randomUUID(),
    identity: { name: "Computer", os: "windows", user: "User", homeDir: "C:\\Users\\User" },
  };
  const connection: SystemHostConnection = {
    readHostStatus: vi.fn<SystemHostConnection["readHostStatus"]>(async () => ({ paired: true, connected: true, hostId: route.hostId, connectionId: route.connectionId, identity: route.identity })),
    executeHostOperation: vi.fn(async (_root, input) => {
      const handler = handlers[input.operation];
      if (!handler) throw new Error("Unexpected companion operation");
      return handler(input.params, { abortSignal: input.abortSignal });
    }),
  };
  return { native, createBackend, resolveTarget, sessions, handlers, route, connection };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
