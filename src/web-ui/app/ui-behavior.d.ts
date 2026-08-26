export type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export declare function matchesSessionQuery(
  values: unknown[],
  query: unknown,
): boolean;

export declare function isNearScrollEnd(
  metrics: ScrollMetrics,
  threshold?: number,
): boolean;

export declare function pinScrollToEnd(
  viewport: ScrollMetrics & {
    style?: { scrollBehavior: string };
  },
): void;

export declare function wrappedIndex(
  currentIndex: number,
  delta: number,
  length: number,
): number;

export declare function normalizeWorkspaceDestination(
  value: unknown,
): "chat" | "operations" | "config";

export declare function createInitialWorkspaceShellState(): {
  workspace: "chat";
  activeSheet: "";
};

export declare function toggleWorkspaceSheet(
  currentSheet: string,
  requestedSheet: string,
): "" | "sessions";

export declare function resolveComposerPrimaryAction(
  activeRequestId: unknown,
  attachmentCount?: number,
): "send" | "steer" | "send_next";

export declare function isMatchingActiveRequest(
  activeRequestId: unknown,
  requestId: unknown,
): boolean;

export declare function insertRequestUserMessageBeforeAssistant<
  T extends { role?: unknown; requestId?: unknown },
>(messages: readonly T[], message: T): T[];
