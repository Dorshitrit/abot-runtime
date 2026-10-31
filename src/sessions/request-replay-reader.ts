import { readdir } from "node:fs/promises";
import {
  getRequestFinalState, getSessionRequest, normalizeAfterSeq, toClientReplayEvent,
} from "./record/projection.js";
import { assertValidRequestId, assertValidSessionId } from "./record/rules.js";
import { projectSessionRequestLifecycle } from "./request-lifecycle/projection.js";
import { ensureSessionsDir, loadSessionFile } from "./session-store.js";
import type { SessionRecord, SessionRequestReplay } from "./types.js";

function normalizedSessionHint(sessionId: string | undefined): string | undefined {
  if (sessionId === undefined) return undefined;
  try {
    assertValidSessionId(sessionId);
    return sessionId;
  } catch {
    // Older callers did not bind replay to a session. A hint never changes authority.
    return undefined;
  }
}

/** Read one conversation at a time; only unresolved raw reads are shared. */
export class SessionRequestReplayReader {
  private readonly pendingSessions = new Map<string, Promise<SessionRecord | null>>();

  constructor(
    private readonly sessionsDir: string,
    private readonly canAccess: (sessionId: string, session: SessionRecord) => boolean,
  ) {}

  async read(
    requestId: string,
    afterSeq = 0,
    sessionIdHint?: string,
  ): Promise<SessionRequestReplay | null> {
    assertValidRequestId(requestId);
    const cursor = normalizeAfterSeq(afterSeq);
    const hint = normalizedSessionHint(sessionIdHint);
    const hintedReplay = await this.readHintedSessionReplay(hint, requestId, cursor);
    if (hintedReplay) return hintedReplay;
    await ensureSessionsDir(this.sessionsDir);
    const names = await readdir(this.sessionsDir);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const sessionId = name.slice(0, -5);
      if (sessionId === hint) continue;
      const replay = await this.readSessionReplay(sessionId, requestId, cursor);
      if (replay) return replay;
    }
    return null;
  }

  private async readHintedSessionReplay(
    sessionId: string | undefined,
    requestId: string,
    afterSeq: number,
  ): Promise<SessionRequestReplay | null> {
    if (sessionId === undefined) return null;
    return this.readSessionReplay(sessionId, requestId, afterSeq);
  }

  private async readSessionReplay(
    sessionId: string,
    requestId: string,
    afterSeq: number,
  ): Promise<SessionRequestReplay | null> {
    const session = await this.readSession(sessionId);
    if (!session) return null;
    // Evaluate access after awaiting the shared I/O, in this caller's own async scope.
    if (!this.canAccess(session.id, session)) return null;
    const request = getSessionRequest(session, requestId);
    if (!request) return null;
    return structuredClone({
      requestId,
      sessionId: request.sessionId,
      ...(request.lifecycle ? { lifecycle: projectSessionRequestLifecycle(request) } : {}),
      ...(request.generation ? { generation: request.generation } : {}),
      events: request.events.filter((event) => event.seqNo > afterSeq).map(toClientReplayEvent),
      finalState: getRequestFinalState(request),
    });
  }

  private async readSession(sessionId: string): Promise<SessionRecord | null> {
    const existing = this.pendingSessions.get(sessionId);
    if (existing) return existing;
    const pending = loadSessionFile(this.sessionsDir, sessionId);
    this.pendingSessions.set(sessionId, pending);
    try {
      return await pending;
    } finally {
      this.pendingSessions.delete(sessionId);
    }
  }
}
