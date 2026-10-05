import type { SessionCreationOptions } from "./project-binding.js";
import type { SessionRecord } from "./types.js";

/** The environment's session directory owns the namespace, not the display name. */
export const SPARK_SESSION_ID = "spark-companion";
export type SessionKind = "spark";

export function isSparkSession(session: { kind?: SessionKind }): boolean {
  return session.kind === "spark";
}

export function assertSessionKindUnchanged(
  session: SessionRecord,
  requested?: SessionKind,
): void {
  if (requested === undefined) return;
  if (session.kind !== requested) throw new Error("session_kind_binding_immutable");
}

export function sessionKindCreationFields(
  sessionId: string,
  options: SessionCreationOptions,
): Pick<SessionRecord, "kind" | "title"> {
  if (options.kind === undefined) return { title: sessionId };
  if (options.kind !== "spark") throw new Error("session_kind_invalid");
  if (sessionId !== SPARK_SESSION_ID) throw new Error("spark_session_identity_invalid");
  if (options.project) throw new Error("spark_session_project_binding_unsupported");
  return { kind: "spark", title: "ABot SPARK" };
}

export function ensureSparkSession(sessions: {
  getOrCreateSession(id: string, options?: SessionCreationOptions): Promise<SessionRecord>;
}): Promise<SessionRecord> {
  return sessions.getOrCreateSession(SPARK_SESSION_ID, { kind: "spark" });
}
