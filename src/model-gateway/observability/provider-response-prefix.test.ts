import { describe, expect, test } from "vitest";
import { ProviderResponsePrefix } from "./provider-response-prefix.js";

describe("bounded provider response prefix", () => {
  test("starts empty and copies incoming bytes and returned snapshots", () => {
    const prefix = new ProviderResponsePrefix();
    expect(prefix.snapshot()).toEqual(Buffer.alloc(0));
    const input = Buffer.from("first");
    prefix.append(input);
    input.fill(0);
    const snapshot = prefix.snapshot();
    prefix.append(Buffer.from(" second"));
    expect(snapshot.toString()).toBe("first");
    snapshot.fill(0);
    expect(prefix.snapshot().toString()).toBe("first second");
  });

  test.each([1, 7, 4093, 16384, 20000])("keeps only the first bytes with %i-byte chunks", (chunkSize) => {
    const source = Buffer.from(Array.from({ length: 100_003 }, (_, i) => i % 251));
    const prefix = new ProviderResponsePrefix();
    for (let offset = 0; offset < source.length; offset += chunkSize) {
      prefix.append(source.subarray(offset, offset + chunkSize));
      prefix.append(new Uint8Array());
    }
    expect(prefix.snapshot()).toEqual(source.subarray(0, 16_384));
  });

  test("reassembles UTF-8 bytes split across chunks without changing the byte limit", () => {
    const source = Buffer.from("שלום 🌍".repeat(2_000));
    const prefix = new ProviderResponsePrefix();
    for (const byte of source) prefix.append(Uint8Array.of(byte));
    const snapshot = prefix.snapshot();
    expect(snapshot).toHaveLength(16_384);
    expect(snapshot).toEqual(source.subarray(0, 16_384));
    // A byte-bounded excerpt may end within a character, just like the existing tail.
    expect(snapshot.toString("utf8")).toBe(source.subarray(0, 16_384).toString("utf8"));
  });
});
