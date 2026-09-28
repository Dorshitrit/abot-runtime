import type { ModelGatewayClient } from "../../ports.js";
import type { CoWorkerResourceBudget } from "./budget.js";
import type { CoWorkerResourceActivity } from "./contracts.js";

type CoWorkerGatewayCall =
  | Parameters<ModelGatewayClient["invoke"]>[0]
  | Parameters<ModelGatewayClient["invokeRaw"]>[0]
  | Parameters<NonNullable<ModelGatewayClient["embed"]>>[0];

/** Scope this client to Co-worker; ordinary chat and memory retain their own client. */
export function createCoWorkerResourceGateway(
  options: Readonly<{
    gateway: ModelGatewayClient;
    budget: CoWorkerResourceBudget;
    activity?: CoWorkerResourceActivity;
    assertActivityAllowed(): void;
    supportsParallel(params: CoWorkerGatewayCall): boolean;
  }>,
): ModelGatewayClient {
  async function invoke<T>(
    params: CoWorkerGatewayCall,
    kind: "model" | "embedding",
    operation: () => Promise<T>,
    embeddingCharacters?: number,
  ): Promise<T> {
    const release = await options.budget.reserve({
      kind,
      ...(options.activity ? { activity: options.activity } : {}),
      supportsParallel: options.supportsParallel(params),
      signal: params.abortSignal,
      assertActivityAllowed: options.assertActivityAllowed,
      ...(embeddingCharacters === undefined ? {} : { embeddingCharacters }),
    });
    try {
      // A pause or window end during the durable reservation must prevent dispatch.
      params.abortSignal.throwIfAborted();
      options.assertActivityAllowed();
      return await operation();
    } finally {
      // A failed, cancelled or interrupted admitted attempt never refunds quota.
      release();
    }
  }
  const { gateway } = options;
  return Object.freeze({
    invoke: (params: Parameters<ModelGatewayClient["invoke"]>[0]) =>
      invoke(params, "model", () => gateway.invoke(params)),
    invokeRaw: (params: Parameters<ModelGatewayClient["invokeRaw"]>[0]) =>
      invoke(params, "model", () => gateway.invokeRaw(params)),
    ...(gateway.countInputTokens
      ? {
          countInputTokens: (
            params: Parameters<
              NonNullable<ModelGatewayClient["countInputTokens"]>
            >[0],
          ) => gateway.countInputTokens!(params),
        }
      : {}),
    ...(gateway.embed
      ? {
          embed: (
            params: Parameters<NonNullable<ModelGatewayClient["embed"]>>[0],
          ) =>
            invoke(
              params,
              "embedding",
              () => gateway.embed!(params),
              params.texts.reduce((total, text) => total + text.length, 0),
            ),
        }
      : {}),
  });
}
