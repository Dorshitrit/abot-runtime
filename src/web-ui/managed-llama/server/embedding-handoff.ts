import { RuntimeSetupError } from "../../local-runtime/runtime-setup-input.js";
import type { ManagedLlamaServerManager } from "./manager.js";

/** Explicit embedding selection joins the existing memory consent/save flow.
 * Credentials remain server-side; enabling memory still requires Test and save.
 */
export function managedEmbeddingHandoff(manager: Pick<ManagedLlamaServerManager, "embeddingConnection">) {
  return (body: Record<string, unknown>): Record<string, unknown> => {
    if (!Object.hasOwn(body, "managedLlamaEmbedding")) return body;
    const ready = manager.embeddingConnection();
    const fail = () => { throw new RuntimeSetupError("managed_embedding_conflict", "Start the managed embedding server and select it again before saving.", 409); };
    if (body.managedLlamaEmbedding !== true || !ready) return fail();
    if (body.provider !== "llamacpp" || Object.hasOwn(body, "providerId")) return fail();
    if (body.model !== ready.model || body.baseUrl !== ready.baseUrl || body.managedLlamaRevision !== ready.revision) return fail();
    if (Object.hasOwn(body, "apiKey") && body.apiKey !== ready.apiKey) return fail();
    const result: Record<string, unknown> = { ...body, apiKey: ready.apiKey, useApiKey: true };
    delete result.managedLlamaEmbedding;
    delete result.managedLlamaRevision;
    return result;
  };
}
