import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { createExecOutputStore } from "../../../plugins/exec/source/output-store.js";
import { createExecProcessOutput } from "../../../plugins/exec/source/process-output.js";
import {
  createRuntimeConfig,
  disposeCompositionFixtures,
} from "./support/runtime-composition-fixture.js";
import { readSingleOutputOwner } from "./support/exec-output-fixture.js";

afterEach(disposeCompositionFixtures);

// This is an 8 MiB disk integrity/backpressure check, not a storage-speed deadline.
// Windows runners also need time for the real flushes and repeated hash reads.
test("captures complete output using pipe backpressure and bounded producer queues", async () => {
  const config = await createRuntimeConfig();
  const store = createExecOutputStore({ stateDir: config.paths.runtimeDir });
  const output = await createExecProcessOutput(store, "capture");
  const stdout = new PassThrough({ highWaterMark: 65_536 });
  const stderr = new PassThrough({ highWaterMark: 65_536 });
  const failed = vi.fn();
  output.attach({ stdout, stderr }, () => {}, failed);
  const payload = Buffer.alloc(65_536, 120);
  const expectedHash = createHash("sha256");
  let maxQueued = 0;
  for (let index = 0; index < 128; index += 1) {
    const ready = stdout.write(payload);
    maxQueued = Math.max(maxQueued, stdout.writableLength);
    expectedHash.update(payload);
    if (!ready) await once(stdout, "drain");
  }
  const drained = Promise.all([once(stdout, "end"), once(stderr, "end")]);
  stdout.end();
  stderr.end();
  await drained;
  await output.finish();
  expect(failed).not.toHaveBeenCalled();
  expect(maxQueued).toBeLessThanOrEqual(65_536);
  const body = output.checkpoint().stdout.body!;
  expect(body.byteLength).toBe(8 * 1024 * 1024);
  expect(body.sha256).toBe(`sha256:${expectedHash.digest("hex")}`);
  const actualHash = createHash("sha256");
  for await (const chunk of store.readRange({
    ownerId: "capture",
    body,
    offset: 0,
    length: body.byteLength,
    maxChunkBytes: 65_536,
  })) {
    expect(chunk.length).toBeLessThanOrEqual(65_536);
    actualHash.update(chunk);
  }
  expect(`sha256:${actualHash.digest("hex")}`).toBe(body.sha256);
}, process.platform === "win32" ? 30_000 : 5_000);

test("starts retention after all writers close and protects an active reader past expiry", async () => {
  const config = await createRuntimeConfig();
  // Advance beyond real capture mtimes so only the active writer protects it.
  let now = Date.now();
  const store = createExecOutputStore({
    stateDir: config.paths.runtimeDir,
    retentionMs: 60_000,
    now: () => now,
  });
  const stdout = await store.createWriter({
    ownerId: "leased",
    stream: "stdout",
  });
  const stderr = await store.createWriter({
    ownerId: "leased",
    stream: "stderr",
  });
  stdout.sink.end("abcdef");
  await stdout.completion;
  now += 120_000;
  expect(await store.cleanupExpired()).toBe(0);
  const owner = await readSingleOutputOwner(config.paths.runtimeDir);
  expect(owner.record.completedAt).toBeNull();
  stderr.sink.end();
  await stderr.completion;
  expect(JSON.parse(await readFile(owner.path, "utf8")).completedAt).toBe(now);
  const body = await stdout.snapshot();
  const reader = store
    .readRange({
      ownerId: "leased",
      body,
      offset: 0,
      length: 6,
      maxChunkBytes: 3,
    })
    [Symbol.asyncIterator]();
  expect(Buffer.from((await reader.next()).value!).toString()).toBe("abc");
  now += 60_001;
  expect(await store.cleanupExpired()).toBe(0);
  expect(Buffer.from((await reader.next()).value!).toString()).toBe("def");
  await reader.return?.();
  expect(await store.cleanupExpired()).toBe(1);
});

test("rejects cross-owner receipts, changed hashes, invalid ranges and changed captured bytes", async () => {
  const config = await createRuntimeConfig();
  const store = createExecOutputStore({ stateDir: config.paths.runtimeDir });
  const writer = await store.createWriter({
    ownerId: "source",
    stream: "stdout",
  });
  writer.sink.end("evidence");
  await writer.completion;
  const body = await writer.snapshot();
  const range = {
    ownerId: "source",
    body,
    offset: 0,
    length: body.byteLength,
    maxChunkBytes: 64,
  };
  const invalid = [
    {
      request: { ...range, ownerId: "other" },
      code: "exec_output_expired_or_unavailable",
    },
    {
      request: {
        ...range,
        body: { ...body, sha256: `sha256:${"0".repeat(64)}` },
      },
      code: "exec_output_snapshot_binding_invalid",
    },
    {
      request: { ...range, length: body.byteLength + 1 },
      code: "exec_output_range_invalid",
    },
  ];
  for (const { request, code } of invalid) {
    await expect(
      store.readRange(request)[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ code });
  }
  const { directory } = await readSingleOutputOwner(config.paths.runtimeDir);
  const name = (await readdir(directory)).find((entry) =>
    entry.endsWith(".bytes"),
  )!;
  await writeFile(join(directory, name), "tampered");
  await expect(
    store.readRange(range)[Symbol.asyncIterator]().next(),
  ).rejects.toMatchObject({ code: "exec_output_body_hash_mismatch" });
});

test("snapshots split UTF-8 into complete contiguous ranges", async () => {
  const config = await createRuntimeConfig();
  const store = createExecOutputStore({ stateDir: config.paths.runtimeDir });
  const writer = await store.createWriter({
    ownerId: "unicode",
    stream: "stdout",
  });
  const bytes = Buffer.from("שלום🚀");
  await new Promise<void>((resolve, reject) => {
    writer.sink.write(bytes.subarray(0, 10), (error) =>
      error ? reject(error) : resolve(),
    );
  });
  expect(writer.byteLength).toBe(10);
  expect(writer.utf8ByteLength).toBe(8);
  const prefix = await writer.snapshot({
    startByte: 0,
    endByte: writer.utf8ByteLength,
  });
  writer.sink.end(bytes.subarray(10));
  await writer.completion;
  const tail = await writer.snapshot({ startByte: prefix.endByte });
  const chunks: Buffer[] = [];
  for (const body of [prefix, tail]) {
    for await (const chunk of store.readRange({
      ownerId: "unicode",
      body,
      offset: 0,
      length: body.byteLength,
      maxChunkBytes: 64,
    }))
      chunks.push(Buffer.from(chunk));
  }
  expect(chunks.map((chunk) => chunk.toString())).toEqual(["שלום", "🚀"]);
  expect(Buffer.concat(chunks)).toEqual(bytes);
});
