import type {
  ReleasedSessionComposerQueueItem,
  SessionComposerAttachmentRef,
  SessionComposerQueueScope,
} from "../lib/session-composer-queue.js";

export type ComposerScope = Readonly<SessionComposerQueueScope>;
export type ComposerAttachment = SessionComposerAttachmentRef & {
  id?: string;
  kind?: string;
  name?: string;
  mimeType?: string;
  sessionId?: string;
  storageRef?: string;
  environment?: string;
};

export interface ComposerDraftSnapshot {
  readonly scope: ComposerScope;
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly release: ReleasedSessionComposerQueueItem | null;
}

/** Mutable editing handle owned by the window-lifetime draft registry. */
export interface ComposerDraft {
  readonly scope: ComposerScope;
  text: string;
  attachments: ComposerAttachment[];
  readonly revision: number;
  readonly generation: number;
  readonly release: ReleasedSessionComposerQueueItem | null;
  readonly uploading: number;
  isEmpty(): boolean;
  setRelease(release: ReleasedSessionComposerQueueItem | null): void;
  startUpload(): number;
  finishUpload(generation: number): void;
  acceptUpload(generation: number, attachment: ComposerAttachment): boolean;
  snapshot(): ComposerDraftSnapshot;
  take(): ComposerDraftSnapshot;
  restore(snapshot: ComposerDraftSnapshot): void;
  clearAttachments(): ComposerAttachment[];
  contains(attachment: ComposerAttachment): boolean;
}

export interface ComposerDrafts {
  clearAttachments(scope: ComposerScope): ComposerAttachment[];
  open(scope: ComposerScope): ComposerDraft;
  restore(snapshot: ComposerDraftSnapshot): void;
  assignSession(draft: ComposerDraft, sessionId: string): ComposerDraft;
  contains(attachment: ComposerAttachment): boolean;
  subscribe(listener: (draft: ComposerDraft) => void): () => boolean;
}

export declare function createComposerDrafts(): ComposerDrafts;
