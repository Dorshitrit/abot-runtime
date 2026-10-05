import { ExecPluginError } from "./errors.js";
import { StringDecoder } from "node:string_decoder";
import { EXEC_OUTPUT_IO_CHUNK_BYTES } from "./output-contracts.js";
import { createExecOutputStore } from "./output-store.js";
import { ExecOutputBuffer } from "./process-output-buffer.js";
import type { ExecProcessSnapshot, ExecStreamSnapshot } from "./types.js";

export type ExecOutputStore = ReturnType<typeof createExecOutputStore>;

export function execOutputOwner(scope: string, processId: string): string {
  return JSON.stringify([scope, processId]);
}

/** Materialize only the observation being delivered, after disk capture. */
export async function materializeExecOutput(
  store: ExecOutputStore,
  scope: string,
  snapshot: ExecProcessSnapshot,
): Promise<ExecProcessSnapshot> {
  if (snapshot.outputFailure) return snapshot;
  const ownerId = execOutputOwner(scope, snapshot.processId);
  async function read(stream: ExecStreamSnapshot): Promise<ExecStreamSnapshot> {
    if (!stream.body) return stream; // Previously persisted inline receipts.
    const decoder = new StringDecoder("utf8");
    const buffer = new ExecOutputBuffer();
    for await (const chunk of store.readRange({
      ownerId,
      body: stream.body,
      offset: 0,
      length: stream.body.byteLength,
      maxChunkBytes: EXEC_OUTPUT_IO_CHUNK_BYTES,
    }))
      buffer.append(decoder.write(Buffer.from(chunk)));
    buffer.append(decoder.end());
    return { ...buffer.peek(), sawOutput: stream.sawOutput, body: stream.body };
  }
  try {
    const stdout = await read(snapshot.stdout);
    const stderr = await read(snapshot.stderr);
    return { ...snapshot, stdout, stderr };
  } catch (error) {
    return {
      ...snapshot,
      outputFailure: {
        code:
          error instanceof ExecPluginError
            ? error.code
            : "exec_output_read_failed",
        stdoutBytes: snapshot.stdout.body?.byteLength ?? 0,
        stderrBytes: snapshot.stderr.body?.byteLength ?? 0,
      },
    };
  }
}
