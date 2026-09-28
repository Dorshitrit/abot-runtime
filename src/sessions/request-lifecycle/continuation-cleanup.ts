import { rm } from "node:fs/promises";
import { join } from "node:path";
import { assertValidSessionId } from "../record/rules.js";
import type { SessionRecord } from "../types.js";
import type { SessionBlobReference } from "./contracts.js";

export function collectSessionContinuationBlobs(
  session: SessionRecord,
): SessionBlobReference[] {
  return (session.requests ?? []).flatMap((request) => {
    const blob = request.lifecycle?.wait?.continuation.blob;
    return blob ? [blob] : [];
  });
}

function isConsumedContinuationBlob(
  sha256: string,
  retained: Set<string>,
): boolean {
  if (retained.has(sha256)) return false;
  return /^[a-f0-9]{64}$/.test(sha256);
}

/** Only remove references retired by a confirmed commit, preserving shared blobs. */
export async function cleanupConsumedSessionContinuations(
  sessionsDir: string,
  session: SessionRecord,
  previous: readonly SessionBlobReference[],
): Promise<void> {
  assertValidSessionId(session.id);
  const retained = new Set(
    collectSessionContinuationBlobs(session).map((blob) => blob.sha256),
  );
  const consumed = new Set(previous.map((blob) => blob.sha256));
  for (const sha256 of consumed) {
    if (!isConsumedContinuationBlob(sha256, retained)) continue;
    try {
      await rm(
        join(
          sessionsDir,
          ".request-continuations",
          encodeURIComponent(session.id),
          `${sha256}.blob`,
        ),
        { force: true },
      );
    } catch (error) {
      console.warn("Consumed session continuation cleanup remains pending.", {
        sessionId: session.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

/** Run after invalidating the session's references; cleanup cannot change its outcome. */
export async function cleanupSessionContinuations(
  sessionsDir: string,
  sessionId: string,
): Promise<void> {
  assertValidSessionId(sessionId);
  try {
    await rm(
      join(
        sessionsDir,
        ".request-continuations",
        encodeURIComponent(sessionId),
      ),
      {
        recursive: true,
        force: true,
      },
    );
  } catch (error) {
    console.warn("Session continuation cleanup remains pending.", {
      sessionId,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}
