import type { RuntimeConfig } from "../../runtime/ports.js";
import type { SessionSnapshotOptions } from "../../sessions/snapshot.js";
import type { SessionSnapshot } from "../../sessions/types.js";
import { DEFAULT_WEB_UI_PAGE_SIZE } from "../../runtime/config/web-ui.js";

export function webPageSize(config: RuntimeConfig): number {
  return config.webUi?.pageSize ?? DEFAULT_WEB_UI_PAGE_SIZE;
}

export function historyPageOptions(url: URL | undefined, config: RuntimeConfig): SessionSnapshotOptions {
  if (url?.searchParams.get("page") !== "1") return { includeRequests: true };
  return { includeRequests: true, page: {
    limit: webPageSize(config), cursor: url.searchParams.get("cursor"),
    targetMessageId: url.searchParams.get("targetMessageId") ?? undefined,
    targetCreatedAt: url.searchParams.has("targetCreatedAt") ? Number(url.searchParams.get("targetCreatedAt")) : undefined,
    targetRequestId: url.searchParams.get("targetRequestId") ?? undefined,
    waitingRequestId: url.searchParams.get("waitingRequestId") ?? undefined,
  } };
}

/** Compact identities stay between the session service and the read-state owner. */
export function publicHistorySnapshot(snapshot: SessionSnapshot) {
  const { messageIndex: _index, ...publicSnapshot } = snapshot;
  return publicSnapshot;
}
