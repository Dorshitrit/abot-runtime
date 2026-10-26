import type { BasketActivity } from "../lib/basket-activity-model.js";

export declare function createConversationBasketActivity(options?: {
  documentRoot?: Document;
  activities?: readonly BasketActivity[];
}): HTMLElement | null;
