import { describe, expect, it, vi } from "vitest";

import {
  SESSION_MEMORY_CHECKPOINT_KIND,
  type SessionMemoryCheckpoint,
} from "../../sessions/memory/contracts.js";
import type { ModelStepContextCompactionController } from "../model/model-step-port.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import {
  createSessionMemoryAwareCompactionController,
  type RequestSessionMemory,
  type SessionMemoryRequestProjection,
} from "../context/session-memory/index.js";

describe("session-memory model-step controller", () => {
  it("compacts session history before delegating active-request compaction", async () => {
    const initial = projection({
      checkpoint: [],
      history: ["old user", "old assistant", "recent user", "recent assistant"],
      compactableTurnCount: 1,
      revision: 0,
    });
    const compacted = projection({
      checkpoint: [{ role: "system", content: "session checkpoint" }],
      history: ["recent user", "recent assistant"],
      compactableTurnCount: 0,
      revision: 1,
    });
    let current = initial;
    const commit = vi.fn(async () => {
      current = compacted;
    });
    const sessionMemory: RequestSessionMemory = Object.freeze({
      project: () => current,
      prepare: vi.fn(async () => ({
        checkpoint: checkpoint(),
        coveredTurnCount: 1,
        projection: compacted,
        commit,
      })),
    });
    const activePrepare =
      vi.fn<ModelStepContextCompactionController["prepare"]>();
    const activeProject = vi.fn((messages) => [...messages]);
    const controller = createSessionMemoryAwareCompactionController(
      {
        sessionId: "session-1",
        sessionMemory,
      } as RequestExecutionScope,
      {
        compactionScope: "active_request",
        project: activeProject,
        prepare: activePrepare,
      },
    );
    const input = [
      { role: "system" as const, content: "root instructions" },
      ...projectMessages(initial),
      { role: "user" as const, content: "current request" },
    ];

    const prepared = await controller.prepare(input);

    expect(controller.compactionScope).toBe("session_history");
    expect(activePrepare).not.toHaveBeenCalled();
    expect(prepared.messages.map(({ content }) => content)).toEqual([
      "root instructions",
      "session checkpoint",
      "recent user",
      "recent assistant",
      "current request",
    ]);
    await prepared.commit();
    expect(commit).toHaveBeenCalledOnce();
    expect(controller.compactionScope).toBe("active_request");

    const reprojected = controller.project(input);
    expect(activeProject).toHaveBeenCalledOnce();
    expect(reprojected.map(({ content }) => content)).toEqual([
      "root instructions",
      "session checkpoint",
      "recent user",
      "recent assistant",
      "current request",
    ]);
  });
});

function projection(params: {
  checkpoint: SessionMemoryRequestProjection["priorConversationMessages"];
  history: readonly string[];
  compactableTurnCount: number;
  revision: number;
}): SessionMemoryRequestProjection {
  return Object.freeze({
    priorConversationMessages: Object.freeze([...params.checkpoint]),
    historyMessages: Object.freeze(
      params.history.map((content, index) => ({
        id: `message-${params.revision}-${index}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content,
        createdAt: new Date(index * 1_000).toISOString(),
      })),
    ),
    compactableTurnCount: params.compactableTurnCount,
    checkpointRevision: params.revision,
    sourceRevision: `source-${params.revision}`,
  });
}

function projectMessages(projection: SessionMemoryRequestProjection) {
  return [
    ...projection.priorConversationMessages,
    ...projection.historyMessages.map(({ role, content }) => ({
      role,
      content,
    })),
  ];
}

function checkpoint(): SessionMemoryCheckpoint {
  return Object.freeze({
    kind: SESSION_MEMORY_CHECKPOINT_KIND,
    revision: 1,
    sourceRevision: `sha256:${"a".repeat(64)}`,
    coveredMessages: Object.freeze([
      Object.freeze({
        messageId: "old-user",
        fingerprint: `sha256:${"b".repeat(64)}`,
      }),
      Object.freeze({
        messageId: "old-assistant",
        fingerprint: `sha256:${"c".repeat(64)}`,
      }),
    ]),
    summary: "session checkpoint",
    createdAt: "2026-08-25T00:00:00.000Z",
  });
}
