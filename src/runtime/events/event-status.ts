import {
  formatDevelopmentProgressTitle,
  formatPlannerPlanItemEventTitle,
  formatPlannerPlanTitle,
} from "./planner-event-status.js";

type BridgeEventPayload = {
  type?: string;
  name?: string;
  tool?: string;
  stage?: string;
  phase?: string;
  reason?: string;
  ok?: boolean;
  actions?: Array<{
    type?: string;
    target?: string;
    details?: string;
  }>;
  status?: string;
  message?: string;
  [key: string]: unknown;
};

const ACTION_LINE_PREFIX_BY_TYPE: Record<string, string> = {
  mkdir: "created folder",
  inspect_target: "read target",
  establish_target: "established target",
  refine_target: "updated target",
  state_already_satisfied: "already up to date",
};

export function formatToolDisplayName(tool: string): string {
  return tool.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function withStatus(
  payload: BridgeEventPayload,
  status: string,
  message?: string,
): BridgeEventPayload {
  return {
    ...payload,
    status,
    message: message ?? status,
  };
}

function withRuntimeStateDetails(
  payload: BridgeEventPayload,
  status: string,
  message?: string,
): { status: string; message?: string } {
  void payload;
  return { status, message };
}

function formatActionLine(action: {
  type?: string;
  target?: string;
  details?: string;
}): string {
  const prefix = action.type
    ? ACTION_LINE_PREFIX_BY_TYPE[action.type]
    : undefined;
  if (prefix && action.target) {
    return `${prefix}: ${action.target}`;
  }
  if (action.type && action.target) {
    return `${action.type.replace(/_/g, " ")}: ${action.target}`;
  }
  if (action.details) {
    return `action: ${action.details}`;
  }
  return "action: unknown";
}

function readToolDisplaySummary(
  payload: BridgeEventPayload,
): string | undefined {
  const meta = payload.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const value = (meta as Record<string, unknown>).displaySummary;
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return undefined;
  }
  const maxLength = 500;
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`;
}

function getToolStartedStatus(tool: string): {
  status: string;
  message: string;
} {
  const displayName = formatToolDisplayName(tool);
  return {
    status: `${displayName}: started`,
    message: `${displayName}...`,
  };
}

function getToolCompletedStatus(
  tool: string,
  ok: boolean,
): {
  status: string;
  messageHeader: string;
} {
  const displayName = formatToolDisplayName(tool);
  return {
    status: `${displayName}: ${ok ? "complete" : "failed"}`,
    messageHeader: `${displayName} ${ok ? "complete" : "failed"}`,
  };
}

function formatRuntimeStateStatus(payload: BridgeEventPayload): {
  status: string;
  message?: string;
} {
  if (
    typeof payload.message === "string" &&
    payload.message.trim().length > 0
  ) {
    return withRuntimeStateDetails(payload, payload.message, payload.message);
  }

  const stage = typeof payload.stage === "string" ? payload.stage : "";
  const phase = typeof payload.phase === "string" ? payload.phase : "";

  if (stage === "task_progress") {
    if (phase === "summarizing") {
      return withRuntimeStateDetails(
        payload,
        "Checking task progress...",
        "Reviewing recent tool results and updating the task checklist...",
      );
    }
    if (phase === "completed") {
      return withRuntimeStateDetails(payload, "Task progress updated");
    }
    if (phase === "failed") {
      return withRuntimeStateDetails(payload, "Task progress check skipped");
    }
  }

  if (stage === "planned_work_review") {
    if (phase === "started") {
      return withRuntimeStateDetails(payload, "Reviewing completed work...");
    }
    if (phase === "passed") {
      return withRuntimeStateDetails(payload, "Completion review passed");
    }
    if (phase === "gaps_found") {
      return withRuntimeStateDetails(payload, "Completion review found gaps");
    }
    if (phase === "limit_reached") {
      return withRuntimeStateDetails(
        payload,
        "Completion review limit reached",
      );
    }
  }

  if (stage === "decision_recovery") {
    if (phase === "strict_retry") {
      return withRuntimeStateDetails(
        payload,
        "Retrying with stricter instructions...",
        "The previous decision was not usable, so the runtime is asking for a stricter tool or final answer.",
      );
    }
    if (phase === "forced_pre_tool") {
      return withRuntimeStateDetails(
        payload,
        "Forcing a valid next action...",
        "The runtime is correcting an invalid first step before any tool work continues.",
      );
    }
  }

  if (stage === "loop_recovery") {
    if (phase === "recap") {
      return withRuntimeStateDetails(
        payload,
        "Recovering task context...",
        "Building a recap from completed work and latest grounded state before trying again.",
      );
    }
    if (phase === "completed") {
      return withRuntimeStateDetails(payload, "Recovery completed");
    }
    if (phase === "degraded") {
      return withRuntimeStateDetails(payload, "Recovery still blocked");
    }
  }

  if (stage === "runtime_degraded") {
    return withRuntimeStateDetails(payload, "Work paused");
  }

  if (stage === "round_limit") {
    return withRuntimeStateDetails(payload, "Round limit reached");
  }

  if (stage === "interaction_mode") {
    return withRuntimeStateDetails(payload, "Checking request mode...");
  }

  if (stage === "context_build") {
    return withRuntimeStateDetails(payload, "Preparing context...");
  }

  if (stage === "chat_final") {
    return withRuntimeStateDetails(payload, "Drafting response...");
  }

  if (stage === "chat_finalization") {
    return withRuntimeStateDetails(payload, "Finalizing response...");
  }

  if (stage === "tool_loop") {
    if (!phase) {
      return withRuntimeStateDetails(payload, "Starting tool work...");
    }
    if (phase === "pre_tool") {
      return withRuntimeStateDetails(payload, "Choosing the next action...");
    }
    if (phase === "post_tool") {
      return withRuntimeStateDetails(
        payload,
        "Checking the latest tool result...",
      );
    }
  }

  if (stage === "finalization") {
    return withRuntimeStateDetails(payload, "Preparing final answer...");
  }

  if (stage === "timeout") {
    return withRuntimeStateDetails(payload, "Request timed out");
  }

  if (stage) {
    return withRuntimeStateDetails(
      payload,
      phase ? `${stage}: ${phase}` : stage,
    );
  }

  return withRuntimeStateDetails(payload, "Runtime update");
}

function withSingleLineEventTitle(
  payload: BridgeEventPayload,
  title: string,
): BridgeEventPayload {
  const { status: _status, message: _message, ...rest } = payload;
  void _status;
  void _message;
  return {
    ...rest,
    name: title,
  };
}

function withoutDuplicateDisplayText(
  payload: BridgeEventPayload,
): BridgeEventPayload {
  const { status: _status, message: _message, ...rest } = payload;
  void _status;
  void _message;
  return rest;
}

export function enrichEventPayload(
  payload: BridgeEventPayload,
): BridgeEventPayload {
  if (payload.type !== "event") {
    return payload;
  }

  const name = typeof payload.name === "string" ? payload.name : "";
  const tool = typeof payload.tool === "string" ? payload.tool : "";

  if (name === "thinking.started" || name === "thinking.delta") {
    return withoutDuplicateDisplayText(payload);
  }

  if (name === "thinking.completed") {
    return withoutDuplicateDisplayText(payload);
  }

  if (name === "runtime.state") {
    const runtimeStatus = formatRuntimeStateStatus(payload);
    return withSingleLineEventTitle(payload, runtimeStatus.status);
  }

  if (name === "context.tools.compact") {
    const trigger =
      typeof payload.compactTrigger === "string" ? payload.compactTrigger : "";
    const status =
      trigger === "baseline_worker_profile"
        ? "Using compact tool list"
        : "Using compact tool list again";
    return withStatus(
      payload,
      status,
      "The model is receiving the compact tool registry profile. No hidden conversation content is shown.",
    );
  }

  if (name === "context.compaction.started") {
    return withStatus(
      payload,
      "Compacting context...",
      "Preparing a smaller context projection while preserving active request state...",
    );
  }

  if (name === "context.compaction.completed") {
    return withStatus(
      payload,
      "Context compacted",
      "The active request context was compacted successfully.",
    );
  }

  if (name === "context.compaction.failed") {
    return withStatus(
      payload,
      "Context compaction failed",
      "The active request context could not be reduced safely.",
    );
  }

  if (name === "planner.plan.created" || name === "planner.plan.updated") {
    return withSingleLineEventTitle(payload, formatPlannerPlanTitle(payload));
  }

  if (name === "development.progress.updated") {
    return withSingleLineEventTitle(
      payload,
      formatDevelopmentProgressTitle(payload),
    );
  }

  if (name === "planner.plan.item.planned") {
    return withSingleLineEventTitle(
      payload,
      formatPlannerPlanItemEventTitle("planned", payload),
    );
  }

  if (name === "planner.plan.item.completed") {
    return withSingleLineEventTitle(
      payload,
      formatPlannerPlanItemEventTitle("completed", payload),
    );
  }

  if (name === "planner.plan.item.blocked") {
    return withSingleLineEventTitle(
      payload,
      formatPlannerPlanItemEventTitle("blocked", payload),
    );
  }

  if (name === "planner.plan.item.started") {
    return withSingleLineEventTitle(
      payload,
      formatPlannerPlanItemEventTitle("started", payload),
    );
  }

  if (name === "planner.plan.item.reopened") {
    return withSingleLineEventTitle(
      payload,
      formatPlannerPlanItemEventTitle("reopened", payload),
    );
  }

  if (name === "tool.started") {
    const explicitStatus =
      typeof payload.status === "string" ? payload.status.trim() : "";
    if (explicitStatus) {
      const explicitMessage =
        typeof payload.message === "string" && payload.message.trim()
          ? payload.message.trim()
          : explicitStatus;
      return withStatus(payload, explicitStatus, explicitMessage);
    }

    if (!tool) {
      return withStatus(payload, "Tool started");
    }

    const status = getToolStartedStatus(tool);
    return withStatus(payload, status.status, status.message);
  }

  if (name === "tool.approval.required") {
    const displayName = tool ? formatToolDisplayName(tool) : "Tool";
    return withStatus(
      payload,
      `${displayName}: approval required`,
      `${displayName}: Waiting for approval`,
    );
  }

  if (name === "tool.approval.granted") {
    const displayName = tool ? formatToolDisplayName(tool) : "Tool";
    return withStatus(
      payload,
      `${displayName}: approved`,
      `${displayName}: Approved`,
    );
  }

  if (name === "tool.approval.rejected") {
    const displayName = tool ? formatToolDisplayName(tool) : "Tool";
    return withStatus(
      payload,
      `${displayName}: rejected`,
      `${displayName}: Rejected`,
    );
  }

  if (name === "tool.payload.started") {
    if (!tool) {
      return withStatus(
        payload,
        "Generating payload...",
        "Generating payload...",
      );
    }
    const displayName = formatToolDisplayName(tool);
    return withStatus(
      payload,
      `${displayName}: generating payload`,
      `${displayName}: Generating payload...`,
    );
  }

  if (name === "tool.payload.completed") {
    if (!tool) {
      return withStatus(payload, "Payload ready");
    }
    const displayName = formatToolDisplayName(tool);
    return withStatus(
      payload,
      `${displayName}: payload ready`,
      `${displayName}: Payload ready`,
    );
  }

  if (name === "tool.payload.failed") {
    if (!tool) {
      return withStatus(payload, "Payload generation failed");
    }
    const displayName = formatToolDisplayName(tool);
    return withStatus(
      payload,
      `${displayName}: payload failed`,
      `${displayName}: Payload generation failed`,
    );
  }

  if (name === "tool.completed") {
    if (!tool) {
      return withStatus(payload, "Tool completed");
    }

    const ok = payload.ok === true;
    const explicitStatus =
      typeof payload.status === "string" ? payload.status.trim() : "";
    const explicitMessage =
      typeof payload.message === "string" ? payload.message.trim() : "";
    const status = explicitStatus
      ? {
          status: explicitStatus,
          messageHeader: explicitMessage || explicitStatus,
        }
      : getToolCompletedStatus(tool, ok);
    const displaySummary = readToolDisplaySummary(payload);
    const actionLines = Array.isArray(payload.actions)
      ? payload.actions.map(formatActionLine)
      : [];
    return withStatus(
      payload,
      status.status,
      [status.messageHeader, displaySummary, ...actionLines]
        .filter((line): line is string => typeof line === "string")
        .join("\n"),
    );
  }

  return payload;
}
