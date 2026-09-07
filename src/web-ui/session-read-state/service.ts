import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { RuntimeConfig, SessionStore } from "../../runtime/ports.js";
import type { SessionSnapshot } from "../../sessions/types.js";
import { SessionService } from "../../sessions/session-service.js";
import {
  clientVisibleMessages,
  toSessionListItem,
  toSnapshotMessage,
} from "../../sessions/record/projection.js";
import { WebReadStateStore } from "./store.js";
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

  async project(environmentId: string, snapshot: SessionSnapshot) {
    const result = await captureReadStateAvailability(() =>
      this.store(environmentId).transaction((state) =>
        projectSessionReadState(state, snapshot.sessionId, snapshot.messages),
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
        includeRequests: false,
      });
      if (!snapshot) return null;
      advanceReadCursor(
        state,
        sessionId,
        snapshot.messages,
        boundary,
        this.now(),
      );
      return projectSessionReadState(state, sessionId, snapshot.messages);
    });
  }

  async list(environmentId: string) {
    const { sessionsDir } =
      this.getEnvironment(environmentId).services.config.paths;
    // One canonical disk enumeration avoids mutable offset pages and sending
    // every request event across the managed Runtime's bounded RPC transport.
    const records = await new SessionService({ sessionsDir }).getAllSessions();
    const projectedSessions = records.map((record) => ({
      summary: toSessionListItem(record),
      messages: clientVisibleMessages(record.messages).map((message) =>
        toSnapshotMessage(record.id, message, record.requests ?? []),
      ),
    }));
    const result = await captureReadStateAvailability(() =>
      this.store(environmentId).transaction((state) => {
        const sessions = projectedSessions.map(({ summary, messages }) => {
          return {
            ...summary,
            ...projectSessionReadState(state, summary.id, messages),
          };
        });
        return { sessions, nextCursor: null };
      }),
    );
    if (result.readStateStatus === "unavailable")
      return {
        sessions: projectedSessions.map(({ summary }) => ({
          ...summary,
          ...unavailableSessionReadState(summary.id),
        })),
        nextCursor: null,
      };
    return result.value;
  }
}
