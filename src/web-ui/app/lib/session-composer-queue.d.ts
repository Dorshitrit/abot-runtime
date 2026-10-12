export interface SessionComposerQueueScope {
  environmentId: string;
  sessionId: string;
}

export type SessionComposerAttachmentRef = Record<string, unknown>;
export type SessionComposerModelPreference = Record<string, unknown>;

export interface SessionComposerQueueItem {
  waitForRequestId: string;
  text: string;
  attachments: SessionComposerAttachmentRef[];
  agentMode: string;
  toolPermissionMode: string;
  modelPreference: SessionComposerModelPreference | null;
}

export interface SessionComposerQueueItemInput {
  waitForRequestId: string;
  text: string;
  attachments: SessionComposerAttachmentRef[];
  agentMode: string;
  toolPermissionMode: string;
  modelPreference?: SessionComposerModelPreference | null;
}

export interface SessionComposerQueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ReleasedSessionComposerQueueItem {
  item: SessionComposerQueueItem;
  releaseToken: string;
  owner?: { id: string; state: "editing" | "sending" | "uncertain" };
}

export interface SessionComposerQueue {
  refresh?(): Promise<void>;
  claimBlockedRelease(scope: SessionComposerQueueScope, releaseToken: string, options?: { takeover?: boolean }): ReleasedSessionComposerQueueItem | null;
  beginBlockedSend(scope: SessionComposerQueueScope, releaseToken: string): boolean;
  markBlockedUncertain(scope: SessionComposerQueueScope, releaseToken: string): boolean;
  enqueue(
    scope: SessionComposerQueueScope,
    item: SessionComposerQueueItemInput,
  ): SessionComposerQueueItem;
  list(scope: SessionComposerQueueScope): SessionComposerQueueItem[];
  peek(scope: SessionComposerQueueScope): SessionComposerQueueItem | null;
  getBlockedRelease(
    scope: SessionComposerQueueScope,
  ): ReleasedSessionComposerQueueItem | null;
  updateBlockedRelease(
    scope: SessionComposerQueueScope,
    releaseToken: string,
    item: SessionComposerQueueItemInput,
  ): boolean;
  releaseForTerminal(
    scope: SessionComposerQueueScope,
    terminalRequestId: string,
  ): ReleasedSessionComposerQueueItem | null;
  bindReleasedSuccess(
    scope: SessionComposerQueueScope,
    releaseToken: string,
    newRequestId: string,
  ): boolean;
  rebindBlocked(
    scope: SessionComposerQueueScope,
    newRequestId: string,
  ): boolean;
}

type QueueMutation = "claimBlockedRelease" | "beginBlockedSend" | "markBlockedUncertain" | "enqueue" | "updateBlockedRelease" | "releaseForTerminal" | "bindReleasedSuccess" | "rebindBlocked";
export type RemoteSessionComposerQueue = Omit<SessionComposerQueue, QueueMutation> & {
  [K in QueueMutation]: (...args: Parameters<SessionComposerQueue[K]>) => Promise<ReturnType<SessionComposerQueue[K]>>;
};

export interface CreateSessionComposerQueueOptions {
  ownerId?: string | null;
  storage?: SessionComposerQueueStorage;
  storageKey?: string;
}

export declare const SESSION_COMPOSER_QUEUE_STORAGE_KEY: string;
export declare function isPersistedStore(value: unknown): boolean;

export declare function createSessionComposerQueue(
  options?: CreateSessionComposerQueueOptions,
): SessionComposerQueue;
