import type { ChatMessage } from "../../model-gateway/types.js";
import { readBoundRequestToolResultsView } from "./request-tool-results-message-binding.js";
import {
  assertSuperWorkerCompactionSidecarBinding,
  readSuperWorkerCompactionSidecar,
  type SuperWorkerCompactionSidecar,
} from "./super-worker-compaction-sidecar.js";

/** Runtime attachment is authority; a copied JSON capsule cannot mint it. */
export function resolveSuperWorkerCompactionProjection(
  messages: readonly ChatMessage[],
  binding: Readonly<{
    requestId: string;
    callId: string;
    sourceRevision: number;
  }>,
  supplied?: SuperWorkerCompactionSidecar,
  required = false,
): SuperWorkerCompactionSidecar | undefined {
  let sidecar = supplied;
  for (const message of messages) {
    const view = readBoundRequestToolResultsView(message);
    if (!view) continue;
    const bound = readSuperWorkerCompactionSidecar(view);
    if (!bound) continue;
    assertSuperWorkerCompactionSidecarBinding(bound, binding);
    if (sidecar && sidecar !== bound) {
      throw new Error("context_compaction_source_binding_conflict");
    }
    sidecar = bound;
  }
  if (!sidecar && required)
    throw new Error("context_compaction_source_binding_required");
  if (!sidecar) return undefined;
  assertSuperWorkerCompactionSidecarBinding(sidecar, binding);
  for (const message of messages) {
    if (!isRequestToolResultsCapsule(message)) continue;
    if (!readBoundRequestToolResultsView(message)) {
      throw new Error("context_compaction_source_message_binding_invalid");
    }
  }
  return sidecar;
}

function isRequestToolResultsCapsule(message: ChatMessage): boolean {
  try {
    return (
      (JSON.parse(message.content) as { kind?: unknown })?.kind ===
      "runtime_request_tool_results_v1"
    );
  } catch {
    return false;
  }
}
