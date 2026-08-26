import type {
  SessionContextEntry,
  SessionMessage,
  SessionMessageObservationMeta,
  SessionRecord,
  ToolObservationTaskResultRole,
} from "./types.js";
import type { RuntimeAttachmentReference } from "../shared/attachments.js";

export type ModelContextMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: RuntimeAttachmentReference[];
  contextMessageKind?:
    | "prior_tool_observation"
    | "development_task_result_observation";
  taskResultRole?: ToolObservationTaskResultRole;
};

export type ContextBuckets = {
  recentConversation: ModelContextMessage[];
  priorToolObservations: ModelContextMessage[];
};

const TOOL_OBSERVATION_ANNOTATION =
  "Context note: This message was derived from a previous tool-based observation and may not reflect current external state.";

type CarryObservationCandidate = {
  context: ModelContextMessage;
  createdAt: string;
  sequence: number;
  sourcePriority: number;
};

const CARRY_SOURCE_PRIORITY = {
  contextEntry: 1,
  message: 2,
} as const;

function isToolObservationMessage(message: SessionMessage): boolean {
  return (
    message.role === "assistant" && message.grounding === "tool_observation"
  );
}

function isTaskResultBoundary(message: SessionMessage): boolean {
  return (
    message.role === "assistant" &&
    message.observationMeta?.kind === "task_result"
  );
}

function shouldCarryToolObservation(message: SessionMessage): boolean {
  if (
    !isToolObservationMessage(message) &&
    typeof message.observationContent !== "string"
  ) {
    return false;
  }
  if (!message.observationMeta) {
    return false;
  }
  return message.observationMeta.carryPolicy === "always";
}

function isTaskResultObservation(message: SessionMessage): boolean {
  return message.observationMeta?.kind === "task_result";
}

function getTaskResultRole(
  message: SessionMessage,
): ToolObservationTaskResultRole | undefined {
  return message.observationMeta?.taskResultRole;
}

function getContextEntryTaskResultRole(
  entry: SessionContextEntry,
): ToolObservationTaskResultRole | undefined {
  return entry.observationMeta.taskResultRole;
}

function buildToolObservationContext(
  content: string,
  meta?: SessionMessageObservationMeta,
): ModelContextMessage {
  const taskResultRole = meta?.taskResultRole;
  return {
    role: "system",
    content: [TOOL_OBSERVATION_ANNOTATION, content].join("\n"),
    contextMessageKind:
      meta?.kind === "task_result"
        ? "development_task_result_observation"
        : "prior_tool_observation",
    ...(taskResultRole ? { taskResultRole } : {}),
  };
}

function toToolObservationContext(
  message: SessionMessage,
): ModelContextMessage {
  return buildToolObservationContext(message.content, message.observationMeta);
}

function toConversationContext(message: SessionMessage): ModelContextMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.attachments && message.attachments.length > 0
      ? { attachments: message.attachments }
      : {}),
  };
}

function isNewerCandidate(
  candidate: CarryObservationCandidate,
  current: CarryObservationCandidate | null,
): boolean {
  if (!current) {
    return true;
  }
  if (candidate.createdAt === current.createdAt) {
    if (candidate.sourcePriority !== current.sourcePriority) {
      return candidate.sourcePriority > current.sourcePriority;
    }
    return candidate.sequence > current.sequence;
  }
  return candidate.createdAt > current.createdAt;
}

function pushCandidateContext(
  target: ModelContextMessage[],
  candidate: CarryObservationCandidate | null,
): void {
  if (candidate) {
    target.push(candidate.context);
  }
}

export function buildContextBuckets(
  session: SessionRecord,
  options: {
    maxConversationMessages?: number;
    maxToolObservationMessages?: number;
    includeRecentConversation?: boolean;
    includeRecentConversationAcrossTaskResults?: boolean;
  } = {},
): ContextBuckets {
  const maxConversationMessages = Number.isFinite(
    options.maxConversationMessages,
  )
    ? Math.max(0, Math.floor(options.maxConversationMessages ?? 3))
    : 3;

  const maxToolObservationMessages = Number.isFinite(
    options.maxToolObservationMessages,
  )
    ? Math.max(0, Math.floor(options.maxToolObservationMessages ?? 2))
    : 2;
  const includeRecentConversation = options.includeRecentConversation !== false;
  const includeRecentConversationAcrossTaskResults =
    options.includeRecentConversationAcrossTaskResults === true;

  const recentConversation: ModelContextMessage[] = [];
  const priorToolObservations: ModelContextMessage[] = [];
  let latestAuthoritativeTaskResultObservation: CarryObservationCandidate | null =
    null;
  let latestSupplementalTaskResultObservation: CarryObservationCandidate | null =
    null;
  let latestFallbackTaskResultObservation: CarryObservationCandidate | null =
    null;

  const recordTaskResultObservation = (
    candidate: CarryObservationCandidate,
    taskResultRole: ToolObservationTaskResultRole | undefined,
  ) => {
    if (taskResultRole === "authoritative_project_handoff") {
      if (
        isNewerCandidate(candidate, latestAuthoritativeTaskResultObservation)
      ) {
        latestAuthoritativeTaskResultObservation = candidate;
      }
      return;
    }
    if (taskResultRole === "supplemental_follow_up") {
      if (
        isNewerCandidate(candidate, latestSupplementalTaskResultObservation)
      ) {
        latestSupplementalTaskResultObservation = candidate;
      }
      return;
    }
    if (isNewerCandidate(candidate, latestFallbackTaskResultObservation)) {
      latestFallbackTaskResultObservation = candidate;
    }
  };

  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i]!;
    const taskResultBoundary = isTaskResultBoundary(message);

    const observationContent =
      typeof message.observationContent === "string"
        ? message.observationContent.trim()
        : "";
    if (observationContent.length > 0 && message.observationMeta) {
      if (
        shouldCarryToolObservation(message) &&
        isTaskResultObservation(message)
      ) {
        const observation = buildToolObservationContext(
          observationContent,
          message.observationMeta,
        );
        const taskResultRole = getTaskResultRole(message);
        recordTaskResultObservation(
          {
            context: observation,
            createdAt: message.createdAt,
            sequence: i,
            sourcePriority: CARRY_SOURCE_PRIORITY.message,
          },
          taskResultRole,
        );
      } else if (
        shouldCarryToolObservation(message) &&
        priorToolObservations.length < maxToolObservationMessages
      ) {
        priorToolObservations.push(
          buildToolObservationContext(
            observationContent,
            message.observationMeta,
          ),
        );
      }
      if (taskResultBoundary && !includeRecentConversationAcrossTaskResults) {
        break;
      }
      continue;
    }

    if (isToolObservationMessage(message)) {
      if (
        shouldCarryToolObservation(message) &&
        isTaskResultObservation(message)
      ) {
        const observation = toToolObservationContext(message);
        const taskResultRole = getTaskResultRole(message);
        recordTaskResultObservation(
          {
            context: observation,
            createdAt: message.createdAt,
            sequence: i,
            sourcePriority: CARRY_SOURCE_PRIORITY.message,
          },
          taskResultRole,
        );
      } else if (
        shouldCarryToolObservation(message) &&
        priorToolObservations.length < maxToolObservationMessages
      ) {
        priorToolObservations.push(toToolObservationContext(message));
      }
      if (taskResultBoundary && !includeRecentConversationAcrossTaskResults) {
        break;
      }
      continue;
    }

    if (taskResultBoundary) {
      if (
        includeRecentConversationAcrossTaskResults &&
        includeRecentConversation &&
        recentConversation.length < maxConversationMessages
      ) {
        recentConversation.push(toConversationContext(message));
      }
      if (!includeRecentConversationAcrossTaskResults) {
        break;
      }
      continue;
    }

    if (
      includeRecentConversation &&
      recentConversation.length < maxConversationMessages
    ) {
      recentConversation.push(toConversationContext(message));
    }

    if (
      recentConversation.length >= maxConversationMessages &&
      priorToolObservations.length >= maxToolObservationMessages
    ) {
      break;
    }
  }

  for (let i = (session.contextEntries ?? []).length - 1; i >= 0; i -= 1) {
    const entry = session.contextEntries?.[i];
    if (!entry || entry.observationMeta.carryPolicy !== "always") {
      continue;
    }
    const content = entry.content.trim();
    if (content.length === 0) {
      continue;
    }
    const observation = buildToolObservationContext(
      content,
      entry.observationMeta,
    );
    if (entry.observationMeta.kind === "task_result") {
      recordTaskResultObservation(
        {
          context: observation,
          createdAt: entry.createdAt,
          sequence: i,
          sourcePriority: CARRY_SOURCE_PRIORITY.contextEntry,
        },
        getContextEntryTaskResultRole(entry),
      );
      continue;
    }
    if (priorToolObservations.length < maxToolObservationMessages) {
      priorToolObservations.push(observation);
    }
  }

  recentConversation.reverse();
  priorToolObservations.reverse();
  pushCandidateContext(
    priorToolObservations,
    latestSupplementalTaskResultObservation,
  );
  if (latestAuthoritativeTaskResultObservation) {
    pushCandidateContext(
      priorToolObservations,
      latestAuthoritativeTaskResultObservation,
    );
  } else {
    pushCandidateContext(
      priorToolObservations,
      latestFallbackTaskResultObservation,
    );
  }

  return {
    recentConversation,
    priorToolObservations,
  };
}

export function buildContextWindow(
  session: SessionRecord,
  maxMessages = 10,
): ModelContextMessage[] {
  const buckets = buildContextBuckets(session, {
    maxConversationMessages: maxMessages,
    maxToolObservationMessages: 0,
  });

  return buckets.recentConversation;
}
