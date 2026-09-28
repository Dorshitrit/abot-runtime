import { createHash, randomUUID } from "node:crypto";
import {
  failureResult,
  successResult,
  type ToolImplementation,
} from "../../plugin-sdk/index.js";
import { isHostIdentifier } from "../companion/protocol.js";
import { resolveSystemTarget } from "../targets.js";
import type { SystemTargetId } from "../contracts.js";
import { computerNumber, computerText } from "./action-input.js";
import { createNativeComputerBackend } from "./native-backend.js";
import type { NativeComputerBackend } from "./native-protocol.js";
import {
  COMPUTER_FRAME_CHUNK_BYTES,
  COMPUTER_IMAGE_MAX_BYTES,
  readNativeComputerRequest,
  readNativeComputerResult,
} from "./native-validation.js";
import { withDesktopQueue } from "./desktop-action-queue.js";

type ComputerSession = {
  backend: NativeComputerBackend;
  expires: ReturnType<typeof setTimeout>;
  frame?: { id: string; bytes: Buffer; nextOffset: number };
};

/** Connection-owned, bounded private sessions. No image is written to disk. */
export class CompanionComputerSessions {
  private readonly sessions = new Map<string, ComputerSession>();
  private readonly closedSessions = new Set<string>();
  private stopped = false;
  constructor(
    private readonly platform: SystemTargetId,
    private readonly createBackend = createNativeComputerBackend,
    private readonly resolveTarget = resolveSystemTarget,
  ) {}

  hasActiveSessions(): boolean {
    return this.sessions.size > 0;
  }

  handlers(): Record<string, ToolImplementation> {
    const protect =
      (handler: ToolImplementation): ToolImplementation =>
      async (params, context) => {
        try {
          return await handler(params, context);
        } catch (error) {
          return failureResult({
            errorCode: "computer_native_operation_failed",
            message:
              error instanceof Error
                ? error.message
                : "The computer operation failed; observe before retrying.",
          });
        }
      };
    return {
      computer_execute: protect((params, context) =>
        this.execute(params, context?.abortSignal),
      ),
      computer_frame: protect(async (params) => this.frame(params)),
      computer_close: protect(async (params) => {
        const id = this.sessionId(params);
        await this.release(id);
        return successResult({ output: "Computer session released." });
      }),
    };
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(
      [...this.sessions.keys()].map((id) => this.release(id)),
    );
  }

  private sessionId(params: Record<string, unknown>): string {
    if (!isHostIdentifier(params.sessionId))
      throw new Error("computer_session_invalid");
    if (params.target !== this.platform)
      throw new Error("computer_platform_mismatch");
    return params.sessionId;
  }

  private async acquire(id: string): Promise<ComputerSession> {
    if (this.stopped) throw new Error("computer_connection_closed");
    if (this.closedSessions.has(id)) throw new Error("computer_session_closed");
    const previous = this.sessions.get(id);
    if (previous) {
      this.renew(id, previous);
      return previous;
    }
    if (this.sessions.size >= 8) throw new Error("computer_session_limit");
    const target = await this.resolveTarget(this.platform);
    if (target.transport !== "native")
      throw new Error("computer_companion_must_be_native");
    if (this.stopped) throw new Error("computer_connection_closed");
    if (this.closedSessions.has(id)) throw new Error("computer_session_closed");
    const session = {
      backend: this.createBackend(target),
      expires: setTimeout(() => void this.release(id), 300_000),
    };
    session.expires.unref();
    this.sessions.set(id, session);
    return session;
  }

  private renew(id: string, session: ComputerSession): void {
    clearTimeout(session.expires);
    session.expires = setTimeout(() => void this.release(id), 300_000);
    session.expires.unref();
  }

  private async execute(params: Record<string, unknown>, signal?: AbortSignal) {
    const id = this.sessionId(params);
    const request = readNativeComputerRequest(params.request);
    return withDesktopQueue(
      `companion-native:${this.platform}`,
      signal,
      async () => {
        const session = await this.acquire(id);
        this.eraseFrame(session);
        const result = await session.backend.execute(request, signal);
        const { image, ...metadata } = result;
        try {
          readNativeComputerResult(metadata);
        } catch (error) {
          image?.bytes.fill(0);
          throw error;
        }
        if (!image)
          return successResult({
            output: "Native desktop observation.",
            data: { result: metadata },
          });
        const frameError = this.imageAdmissionError(
          id,
          session,
          image.bytes.byteLength,
          signal,
        );
        if (frameError) {
          image.bytes.fill(0);
          return successResult({
            output: "Native action receipt retained; image unavailable.",
            data: {
              result: {
                ...metadata,
                error: {
                  code: frameError,
                  message:
                    "Image unavailable after native execution. Preserve the dispatch receipt and observe again before another action.",
                },
              },
            },
          });
        }
        const bytes = Buffer.from(image.bytes);
        image.bytes.fill(0);
        const frameId = randomUUID();
        session.frame = { id: frameId, bytes, nextOffset: 0 };
        return successResult({
          output: "Native desktop observation; image transfer pending.",
          data: {
            result: metadata,
            frame: {
              id: frameId,
              size: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          },
        });
      },
    );
  }

  private imageAdmissionError(
    id: string,
    session: ComputerSession,
    size: number,
    signal?: AbortSignal,
  ): string | undefined {
    if (signal?.aborted) return "computer_capture_cancelled";
    if (this.stopped || this.closedSessions.has(id))
      return "computer_session_closed";
    if (this.sessions.get(id) !== session) return "computer_session_closed";
    if (size < 1) return "computer_image_empty";
    if (size > COMPUTER_IMAGE_MAX_BYTES) return "computer_image_limit";
    return undefined;
  }

  private frame(params: Record<string, unknown>) {
    const session = this.sessions.get(this.sessionId(params));
    const frame = session?.frame;
    if (!session || !frame) throw new Error("computer_frame_expired");
    if (computerText(params.frameId, 128) !== frame.id)
      throw new Error("computer_frame_identity_mismatch");
    const offset = computerNumber(params.offset, 0, COMPUTER_IMAGE_MAX_BYTES);
    if (offset !== frame.nextOffset)
      throw new Error("computer_frame_offset_mismatch");
    const end = Math.min(
      offset + COMPUTER_FRAME_CHUNK_BYTES,
      frame.bytes.length,
    );
    const bytes = frame.bytes.subarray(offset, end).toString("base64");
    frame.nextOffset = end;
    if (end === frame.bytes.length) this.eraseFrame(session);
    return successResult({ output: "Private image chunk.", data: { bytes } });
  }

  private eraseFrame(session: ComputerSession): void {
    session.frame?.bytes.fill(0);
    delete session.frame;
  }

  private async release(id: string): Promise<void> {
    this.closedSessions.add(id);
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    clearTimeout(session.expires);
    this.eraseFrame(session);
    await session.backend.close();
  }
}
