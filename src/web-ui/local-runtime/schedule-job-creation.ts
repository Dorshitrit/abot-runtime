import { randomUUID } from "node:crypto";
import type { SessionRecord } from "../../sessions/types.js";
import type { SessionStore } from "../../runtime/ports.js";
import type {
  CreateSchedulerJobInput,
  SchedulerService,
} from "../../runtime/scheduler/contracts.js";
import { validateSchedulerJobInput } from "../../runtime/scheduler/schedule-validation.js";
import type { JsonObject } from "./contracts.js";

export type ScheduleConversationStore = Pick<
  SessionStore,
  | "getOrCreateSession"
  | "getSessionById"
  | "updateSessionTitle"
  | "deleteSession"
>;
type ScheduleCreationService = Pick<SchedulerService, "create" | "list">;

function requestsDedicatedConversation(body: JsonObject | null): boolean {
  if (body?.newConversation === undefined) return false;
  if (body.newConversation === false) return false;
  if (body.newConversation !== true)
    throw new Error(
      "scheduler_invalid_job: newConversation must be a boolean.",
    );
  if (body.sessionId !== undefined)
    throw new Error(
      "scheduler_invalid_job: Choose a new or existing conversation.",
    );
  return true;
}

function isEmptyScheduleConversation(session: SessionRecord): boolean {
  if (session.messageCount !== 0) return false;
  if (session.messages.length > 0) return false;
  if (session.requests?.length) return false;
  return true;
}

async function removeUnlinkedScheduleConversation(
  service: ScheduleCreationService,
  sessions: ScheduleConversationStore,
  sessionId: string,
): Promise<boolean> {
  try {
    const jobs = await service.list({ sessionId });
    if (jobs.length > 0) return false;
    const session = await sessions.getSessionById(sessionId);
    if (!session) return true;
    if (!isEmptyScheduleConversation(session)) return false;
    return await sessions.deleteSession(sessionId);
  } catch {
    // A failed lookup cannot prove that the save failed or the session is unused.
    return false;
  }
}

export async function createWebScheduleJob(
  service: ScheduleCreationService,
  sessions: ScheduleConversationStore | undefined,
  body: JsonObject | null,
) {
  if (!requestsDedicatedConversation(body))
    return service.create(body as unknown as CreateSchedulerJobInput);
  if (!sessions)
    throw new Error(
      "scheduler_unavailable: Conversation storage is unavailable.",
    );

  const {
    newConversation: _newConversation,
    sessionId: _sessionId,
    ...fields
  } = body!;
  const sessionId = `job-${randomUUID()}`;
  const input = { ...fields, sessionId } as CreateSchedulerJobInput;
  validateSchedulerJobInput(input);
  try {
    await sessions.getOrCreateSession(sessionId);
    const session = await sessions.updateSessionTitle(sessionId, input.title);
    if (!session) throw new Error("scheduler_session_not_found");
    return await service.create(input);
  } catch (error) {
    if (await removeUnlinkedScheduleConversation(service, sessions, sessionId))
      throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not confirm the Job save: ${detail}. The conversation was kept; check Jobs before saving again.`,
      { cause: error },
    );
  }
}
