import type { Readable } from "node:stream";
import type { ExecOutputBody, ExecOutputWriter } from "./output-contracts.js";
import type { ExecOutputStore } from "./output-snapshot.js";
import type { ExecProcessSnapshot, ExecStreamSnapshot } from "./types.js";

type OutputReceipt = Pick<
  ExecProcessSnapshot,
  "stdout" | "stderr" | "outputFailure"
>;

function streamReceipt(body?: ExecOutputBody): ExecStreamSnapshot {
  return {
    text: "",
    sawOutput: (body?.endByte ?? 0) > 0,
    metadata: {
      truncated: false,
      originalChars: 0,
      returnedChars: 0,
      omittedChars: 0,
    },
    ...(body ? { body } : {}),
  };
}

/** Pipe backpressure bounds capture RAM; accepted offsets advance separately. */
export async function createExecProcessOutput(
  store: ExecOutputStore,
  ownerId: string,
) {
  const stdout = await store.createWriter({ ownerId, stream: "stdout" });
  let stderr: ExecOutputWriter;
  try {
    stderr = await store.createWriter({ ownerId, stream: "stderr" });
  } catch (error) {
    await stdout.dispose();
    throw error;
  }
  const offsets = { stdout: 0, stderr: 0 };
  let settled: OutputReceipt | undefined;
  let failure: string | undefined;
  let finished = false;
  let tail = Promise.resolve();
  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const recordFailure = (error: unknown) => {
    failure ??=
      error instanceof Error ? error.message : "exec_output_write_failed";
  };
  const capture = async (): Promise<OutputReceipt> => {
    try {
      const out = await stdout.snapshot({
        startByte: offsets.stdout,
        endByte: finished ? stdout.byteLength : stdout.utf8ByteLength,
      });
      const err = await stderr.snapshot({
        startByte: offsets.stderr,
        endByte: finished ? stderr.byteLength : stderr.utf8ByteLength,
      });
      return {
        stdout: streamReceipt(out),
        stderr: streamReceipt(err),
        ...failureReceipt(),
      };
    } catch (error) {
      recordFailure(error);
      return {
        stdout: streamReceipt(),
        stderr: streamReceipt(),
        ...failureReceipt(),
      };
    }
  };
  const failureReceipt = () =>
    failure
      ? {
          outputFailure: {
            code: failure,
            stdoutBytes: stdout.byteLength,
            stderrBytes: stderr.byteLength,
          },
        }
      : {};
  return Object.freeze({
    attach(
      streams: { stdout: Readable; stderr: Readable },
      onActivity: () => void,
      onFailure: () => void,
    ) {
      for (const name of ["stdout", "stderr"] as const) {
        const source = streams[name];
        const writer = name === "stdout" ? stdout : stderr;
        source.on("data", onActivity);
        const failed = (error: Error) => {
          recordFailure(error);
          source.pause();
          onFailure();
        };
        writer.sink.on("error", failed);
        source.on("error", failed);
        source.pipe(writer.sink);
      }
    },
    async finish() {
      if (!stdout.sink.writableEnded) stdout.sink.end();
      if (!stderr.sink.writableEnded) stderr.sink.end();
      const outcomes = await Promise.allSettled([
        stdout.completion,
        stderr.completion,
      ]);
      for (const outcome of outcomes)
        if (outcome.status === "rejected") recordFailure(outcome.reason);
      await serialize(async () => {
        finished = true;
        settled = await capture();
      });
    },
    peek(): Promise<OutputReceipt> {
      return serialize(async () => settled ?? (await capture()));
    },
    checkpoint(): OutputReceipt {
      if (!settled) throw new Error("exec_snapshot_not_quiescent");
      return settled;
    },
    accept(snapshot: ExecProcessSnapshot): Promise<void> {
      return serialize(async () => {
        if (snapshot.outputFailure)
          throw new Error("exec_output_not_delivered");
        for (const name of ["stdout", "stderr"] as const) {
          const body = snapshot[name].body;
          const writer = name === "stdout" ? stdout : stderr;
          if (
            !body ||
            body.startByte !== offsets[name] ||
            body.endByte > writer.byteLength
          )
            throw new Error("exec_output_snapshot_mismatch");
        }
        offsets.stdout = snapshot.stdout.body!.endByte;
        offsets.stderr = snapshot.stderr.body!.endByte;
        if (finished) settled = await capture();
      });
    },
    async dispose() {
      await Promise.all([stdout.dispose(), stderr.dispose()]);
    },
  });
}
