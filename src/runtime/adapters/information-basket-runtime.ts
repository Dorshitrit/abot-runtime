import type { InformationBasketService } from "../information-basket/contracts.js";
import { traceDebug } from "../observability/debug-logger.js";

/** Basket failure remains visible in Resources; optional indexing cannot block chat startup. */
export async function startRuntimeInformationBasket(service?: InformationBasketService): Promise<void> {
  if (!service) return;
  try {
    await service.start();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    traceDebug("runtime.information_basket", "startup.unavailable", {
      reason: typeof code === "string" ? code : "basket_service_unavailable",
    });
  }
}
