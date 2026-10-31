import { projectAssistantReadEvidence, type AssistantReadEvidence } from "./assistant-read-evidence.js";
import { sessionListOverview } from "./overview.js";
import { sessionMetadataPage } from "./pagination.js";
import { sidebarMetadataPage, type SidebarSessionPageQuery } from "./sidebar-pagination.js";
import type { RuntimeProjectCatalog } from "../../runtime/projects/contracts.js";
import { webPageSize } from "../local-runtime/history-pagination.js";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { RuntimeConfig, SessionStore } from "../../runtime/ports.js";
import type { SessionSnapshot } from "../../sessions/types.js";
import { listSessionMetadata } from "../../sessions/metadata/store.js";
import { isSparkSession } from "../../sessions/spark-session.js";
import { markVisibleAssistantMessages, projectVisibleSessionReadState, visibleReadMessageIds, visibleReadObservations } from "./visible-messages.js";
import { WebReadStateStore } from "./store.js";
import { resetConversationReadStates } from "./reset.js";
import type { RuntimeSessionsResetResult } from "../../runtime/local-host/maintenance-contracts.js";
import {
  captureReadStateAvailability,
  unavailableSessionReadState,
} from "./availability.js";
import {
  advanceReadCursor,
  projectSessionReadState,
  type ReadBoundary,
} from "./projection.js";

type Sessions = Pick<SessionStore, "getSessionSnapshot">;
type Environment = { services: { config: RuntimeConfig; sessions: Sessions } };

export class WebSessionReadStates {
  private readonly stores = new Map<string, WebReadStateStore>();
  private readonly initializedAt: number;

  constructor(
    private readonly getEnvironment: (id: string) => Environment,
    private readonly now: () => number = Date.now,
  ) {
    this.initializedAt = now();
  }

  private store(environmentId: string): WebReadStateStore {
    const { paths } = this.getEnvironment(environmentId).services.config;
    const identity = JSON.stringify([
      environmentId,
      resolve(paths.sessionsDir),
    ]);
    const existing = this.stores.get(identity);
    if (existing) return existing;
    const filename =
      createHash("sha256").update(identity).digest("hex") + ".json";
    const store = new WebReadStateStore(
      join(paths.runtimeDir, "web-ui", "read-state", filename),
      this.initializedAt,
    );
    this.stores.set(identity, store);
    return store;
  }

  initialize(environmentId: string): Promise<void> {
    return this.store(environmentId).initialize();
  }
  async forget(environmentId: string, sessionId: string): Promise<void> {
    await captureReadStateAvailability(() =>
      this.store(environmentId).forget(sessionId),
    );
  }
  async reset(environmentId: string, sessionId: string): Promise<void> {
    await captureReadStateAvailability(() =>
      this.store(environmentId).reset(sessionId, this.now()),
    );
  }

  resetConversations(environmentId: string, operation: () => Promise<RuntimeSessionsResetResult>): Promise<RuntimeSessionsResetResult> {
    return resetConversationReadStates(this.store(environmentId), operation, this.now);
  }

  async assistantReadEvidence(environmentId: string, sessionId: string): Promise<AssistantReadEvidence> {
    const result = await captureReadStateAvailability(() =>
      this.store(environmentId).transaction(async (state): Promise<AssistantReadEvidence> => {
        const sessions = this.getEnvironment(environmentId).services.sessions;
        const snapshot = await sessions.getSessionSnapshot(sessionId, { includeRequests: false, identitiesOnly: true });
        if (!snapshot) return { status: "unavailable" };
        return projectAssistantReadEvidence(state, snapshot);
      }),
    );
    if (result.readStateStatus === "unavailable") return { status: "unavailable" };
    return result.value;
  }

  async project(environmentId: string, snapshot: SessionSnapshot) {
    const result = await captureReadStateAvailability(() =>
      this.store(environmentId).transaction((state) =>
        isSparkSession(snapshot)
          ? projectVisibleSessionReadState(state, snapshot.sessionId, (snapshot.messageIndex ?? snapshot.messages))
          : projectSessionReadState(state, snapshot.sessionId, (snapshot.messageIndex ?? snapshot.messages)),
      ),
    );
    if (result.readStateStatus === "unavailable")
      return unavailableSessionReadState(snapshot.sessionId);
    return result.value;
  }

  async mark(environmentId: string, sessionId: string, boundary: ReadBoundary) {
    const store = this.store(environmentId);
    await store.initialize();
    const sessions = this.getEnvironment(environmentId).services.sessions;
    return store.transaction(async (state) => {
      const snapshot = await sessions.getSessionSnapshot(sessionId, {
        includeRequests: false, identitiesOnly: true,
      });
      if (!snapshot) return null;
      if (isSparkSession(snapshot))
        return projectVisibleSessionReadState(state, sessionId, (snapshot.messageIndex ?? snapshot.messages));
      advanceReadCursor(
        state,
        sessionId,
        (snapshot.messageIndex ?? snapshot.messages),
        boundary,
        this.now(),
      );
      return projectSessionReadState(state, sessionId, (snapshot.messageIndex ?? snapshot.messages));
    });
  }

  async markVisible(environmentId: string, sessionId: string, input: unknown, generation: unknown, visibleMessages: unknown) {
    const ids = visibleReadMessageIds(input);
    const observations = visibleReadObservations(ids, visibleMessages);
    const sessions = this.getEnvironment(environmentId).services.sessions;
    return this.store(environmentId).transaction(async (state) => {
      const snapshot = await sessions.getSessionSnapshot(sessionId, { includeRequests: false, identitiesOnly: true });
      if (!snapshot || !isSparkSession(snapshot)) return null;
      markVisibleAssistantMessages(state, sessionId, (snapshot.messageIndex ?? snapshot.messages), observations, generation, this.now());
      return projectVisibleSessionReadState(state, sessionId, (snapshot.messageIndex ?? snapshot.messages));
    });
  }

  async list(environmentId: string, query?: SidebarSessionPageQuery, catalog?: RuntimeProjectCatalog) {
    const { sessionsDir } =
      this.getEnvironment(environmentId).services.config.paths;
    const records = await listSessionMetadata(sessionsDir);
    const projectedSessions = records.filter((record) => record.interactive)
      .filter((record) => !isSparkSession(record.summary));
    const limit = webPageSize(this.getEnvironment(environmentId).services.config);
    const page = this.listPage(projectedSessions, query, limit, catalog);
    const { records: selected, ...pageInfo } = page;
    const result = await captureReadStateAvailability(() =>
      this.store(environmentId).transaction((state) => {
        const sessions = selected.map(({ summary, messages }) => {
          return {
            ...summary,
            ...projectSessionReadState(state, summary.id, messages),
          };
        });
        return { sessions, ...pageInfo, ...(query && !query.cursor ? { overview: sessionListOverview(projectedSessions, query.archivedSessionIds, state) } : {}) };
      }),
    );
    if (result.readStateStatus === "unavailable")
      return {
        sessions: selected.map(({ summary }) => ({
          ...summary,
          ...unavailableSessionReadState(summary.id),
        })),
        ...pageInfo,
        ...(query && !query.cursor ? { overview: sessionListOverview(projectedSessions, query.archivedSessionIds) } : {}),
      };
    return result.value;
  }

  private listPage(records: Awaited<ReturnType<typeof listSessionMetadata>>, query: SidebarSessionPageQuery | undefined,
    limit: number, catalog?: RuntimeProjectCatalog) {
    if (!query) return { records, nextCursor: null };
    if (query.sidebar !== true) return sessionMetadataPage(records, query, limit);
    if (!catalog) throw new Error("projects_unavailable");
    return sidebarMetadataPage(records, query, limit, catalog);
  }
}
