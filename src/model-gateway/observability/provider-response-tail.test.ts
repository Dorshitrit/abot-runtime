import { describe, expect, test } from "vitest";
import { ProviderResponseTail } from "./provider-response-tail.js";

describe("bounded provider response tail", () => {
  test("starts empty and returns a snapshot independent of later writes", () => {
    const tail = new ProviderResponseTail();
    expect(tail.snapshot()).toEqual(Buffer.alloc(0));
    tail.append(Buffer.from("first"));
    const snapshot = tail.snapshot();
    tail.append(Buffer.from(" second"));
    expect(snapshot.toString()).toBe("first");
    expect(tail.snapshot().toString()).toBe("first second");
  });

  test.each([1, 7, 4093, 16384, 20000])("preserves byte order after repeated wraps with %i-byte chunks", (chunkSize) => {
    const source = Buffer.from(Array.from({ length: 100_003 }, (_, i) => i % 251));
    const tail = new ProviderResponseTail();
    for (let offset = 0; offset < source.length; offset += chunkSize) {
      tail.append(source.subarray(offset, offset + chunkSize));
      tail.append(new Uint8Array());
    }
    expect(tail.snapshot()).toEqual(source.subarray(-16_384));
  });

  test("discards the old tail on a large chunk and retains subsequent bytes", () => {
    const tail = new ProviderResponseTail();
    tail.append(Buffer.from("stale"));
    tail.append(Buffer.alloc(20_000, 1));
    tail.append(Buffer.from([2, 3, 4]));
    const expected = Buffer.concat([Buffer.alloc(16_381, 1), Buffer.from([2, 3, 4])]);
    expect(tail.snapshot()).toEqual(expected);
  });
});
