import { projectSessionRuntimePaths } from "../../runtime/projects/session-paths.js";
import {
  parseToolFileOutputReceipt,
  type ToolFileOutputReceipt,
} from "../../capabilities/file-output-presentation.js";
import type { SessionRequestReplay } from "../../sessions/types.js";
import type { JsonObject } from "./contracts.js";
import type { RuntimeEnvironmentRegistry } from "./environment-registry.js";
import type { LocalRequestExecution } from "./request-execution.js";
import { ConversationFileError } from "./conversation-file-format.js";

export type ConversationFileReference = {
  environmentId: string;
  sessionId: string;
  requestId: string;
  executionId: string;
};

function unavailable(): never {
  throw new ConversationFileError(
    "conversation_file_unavailable",
    404,
    "This file is no longer available in this conversation.",
  );
}

function isReferenceId(value: string | null): value is string {
  if (!value || value.length > 300) return false;
  if (value.includes("/")) return false;
  if (value.includes(String.fromCharCode(92))) return false;
  return ![...value].some((character) => character.charCodeAt(0) < 32);
}

export function readConversationFileReference(
  url: URL,
): ConversationFileReference {
  const environmentId = url.searchParams.get("environment");
  const sessionId = url.searchParams.get("sessionId");
  const requestId = url.searchParams.get("requestId");
  const executionId = url.searchParams.get("executionId");
  const values = [environmentId, sessionId, requestId, executionId];
  if (!values.every(isReferenceId))
    throw new ConversationFileError(
      "file_reference_invalid",
      400,
      "The file reference is incomplete. Open it from the conversation activity.",
    );
  return {
    environmentId: environmentId!,
    sessionId: sessionId!,
    requestId: requestId!,
    executionId: executionId!,
  };
}

function belongsToConversation(
  replay: SessionRequestReplay | null,
  reference: ConversationFileReference,
): replay is SessionRequestReplay {
  if (!replay) return false;
  if (replay.requestId !== reference.requestId) return false;
  return replay.sessionId === reference.sessionId;
}

function hasRecordedCompletion(
  events: readonly JsonObject[],
  reference: ConversationFileReference,
): boolean {
  return events.some(
    (event) =>
      event.name === "tool.completed" &&
      event.executionId === reference.executionId &&
      event.requestId === reference.requestId,
  );
}

function completedFileReceipt(
  events: readonly JsonObject[],
  reference: ConversationFileReference,
): ToolFileOutputReceipt | undefined {
  const matches = events.filter((event) =>
    isReferencedCompletion(event, reference),
  );
  if (matches.length !== 1) return undefined;
  const meta = matches[0]?.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    return undefined;
  return parseToolFileOutputReceipt((meta as JsonObject).fileOutput);
}

function isReferencedCompletion(
  event: JsonObject,
  reference: ConversationFileReference,
): boolean {
  if (event.type !== "event" || event.name !== "tool.completed") return false;
  if (event.requestId !== reference.requestId) return false;
  if (event.executionId !== reference.executionId) return false;
  return event.ok === true;
}

function sameFileReceipt(
  original: ToolFileOutputReceipt,
  current: ToolFileOutputReceipt | undefined,
): boolean {
  if (!current) return false;
  return Object.entries(original).every(
    ([key, value]) => current[key as keyof ToolFileOutputReceipt] === value,
  );
}

/** The recorded completion and its request generation own every file action. */
export class ConversationFileAccess {
  constructor(
    private readonly environments: Pick<
      RuntimeEnvironmentRegistry,
      "environmentConfig" | "setupRequirement" | "get"
    >,
    private readonly requests: LocalRequestExecution,
    private readonly defaultEnvironmentId: () => string,
  ) {}

  async authorize(reference: ConversationFileReference) {
    const environment = this.resolveEnvironment(reference.environmentId);
    const sessions = environment.services.sessions;
    const session = await sessions.getSessionById(reference.sessionId);
    if (!session) unavailable();
    const paths = projectSessionRuntimePaths(
      environment.services.config.paths,
      session,
    );
    const replay = await sessions.getRequestReplayById(reference.requestId);
    if (!belongsToConversation(replay, reference)) unavailable();
    // Late events after clear cannot recreate the explicitly started generation.
    if (!replay.generation) unavailable();
    const wasRecorded = hasRecordedCompletion(replay.events, reference);
    const receipt = this.fileReceipt(replay, reference, !wasRecorded);
    if (!receipt) unavailable();
    return {
      receipt,
      paths,
      assertCurrent: async () => {
        if (this.resolveEnvironment(reference.environmentId) !== environment)
          unavailable();
        const current = await sessions.getRequestReplayById(
          reference.requestId,
        );
        if (this.resolveEnvironment(reference.environmentId) !== environment)
          unavailable();
        if (!belongsToConversation(current, reference)) unavailable();
        if (current.generation !== replay.generation) unavailable();
        // A persisted completion must stay persisted; only the original gap may use live events.
        if (
          !sameFileReceipt(
            receipt,
            this.fileReceipt(current, reference, !wasRecorded),
          )
        )
          unavailable();
      },
    };
  }

  private fileReceipt(
    replay: SessionRequestReplay,
    reference: ConversationFileReference,
    allowActive: boolean,
  ): ToolFileOutputReceipt | undefined {
    if (hasRecordedCompletion(replay.events, reference))
      return completedFileReceipt(replay.events, reference);
    if (!allowActive) return undefined;
    const active = this.requests.activeReplayForSession(
      reference.requestId,
      reference.sessionId,
      reference.environmentId,
    );
    return completedFileReceipt(active ?? [], reference);
  }

  private resolveEnvironment(environmentId: string) {
    const configured = this.environments.environmentConfig();
    const available = configured
      ? configured.environments.some((item) => item.id === environmentId)
      : environmentId === this.defaultEnvironmentId();
    if (!available) unavailable();
    if (this.environments.setupRequirement(environmentId)) unavailable();
    return this.environments.get(environmentId);
  }
}
