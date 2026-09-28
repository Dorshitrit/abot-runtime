import { createHash, randomUUID } from "node:crypto";
import type { ComputerAccessConnection, CompanionTarget } from "../client.js";
import { SystemOperationError } from "../contracts.js";
import type {
  NativeComputerBackend,
  NativeComputerRequest,
} from "./native-protocol.js";
import {
  computerNumber,
  computerRecord,
  computerText,
} from "./action-input.js";
import {
  COMPUTER_FRAME_CHUNK_BYTES,
  COMPUTER_IMAGE_MAX_BYTES,
  readNativeComputerResult,
} from "./native-validation.js";

export function createCompanionComputerBackend(
  rootDir: string,
  route: CompanionTarget,
  connection: ComputerAccessConnection,
): NativeComputerBackend {
  const sessionId = randomUUID();
  let closed = false;
  const call = async (
    operation: "computer_execute" | "computer_frame" | "computer_close",
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    const result = await connection.executeHostOperation(rootDir, {
      hostId: route.hostId,
      connectionId: route.connectionId,
      operation,
      params: { ...params, sessionId, target: route.target },
      ...(signal ? { abortSignal: signal } : {}),
    });
    if (!result.ok)
      throw new SystemOperationError(
        result.errorCode ?? "computer_host_failed",
        result.output,
      );
    return computerRecord(result.data);
  };
  return {
    async execute(request: NativeComputerRequest, signal?: AbortSignal) {
      if (closed)
        throw new SystemOperationError(
          "computer_session_closed",
          "The desktop session has closed.",
        );
      const response = await call("computer_execute", { request }, signal);
      const result = readNativeComputerResult(response.result);
      if (response.frame === undefined) return result;
      let bytes: Buffer | undefined;
      try {
        const frame = computerRecord(response.frame);
        const id = computerText(frame.id, 128);
        const size = computerNumber(frame.size, 1, COMPUTER_IMAGE_MAX_BYTES);
        if (!Number.isInteger(size))
          throw new Error("computer_frame_size_invalid");
        const hash = computerText(frame.sha256, 64);
        bytes = Buffer.alloc(size);
        for (
          let offset = 0;
          offset < size;
          offset += COMPUTER_FRAME_CHUNK_BYTES
        ) {
          const chunk = await call(
            "computer_frame",
            { frameId: id, offset },
            signal,
          );
          const encoded = computerText(
            chunk.bytes,
            COMPUTER_FRAME_CHUNK_BYTES * 2,
          );
          const decoded = Buffer.from(encoded, "base64");
          if (
            decoded.length !==
            Math.min(COMPUTER_FRAME_CHUNK_BYTES, size - offset)
          )
            throw new Error("computer_frame_chunk_invalid");
          decoded.copy(bytes, offset);
          decoded.fill(0);
        }
        if (createHash("sha256").update(bytes).digest("hex") !== hash)
          throw new Error("computer_frame_digest_invalid");
        return { ...result, image: { mimeType: "image/png" as const, bytes } };
      } catch (error) {
        bytes?.fill(0);
        // Retain a completed injection receipt even when image transfer fails.
        if (result.dispatch)
          return {
            ...result,
            error: {
              code: "computer_frame_transfer_failed",
              message:
                "Input receipt is preserved; the resulting image could not be transferred. Observe again before another action.",
            },
          };
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const deadline = AbortSignal.timeout(3000);
      await call("computer_close", {}, deadline).catch(() => undefined);
    },
  };
}
