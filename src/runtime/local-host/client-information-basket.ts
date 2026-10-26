import type { InformationBasketService } from "../information-basket/contracts.js";
import type { LocalRuntimeCallHandler } from "./contracts.js";

export type InformationBasketManagement = Pick<InformationBasketService,
  "list" | "updateSettings" | "browseFiles" | "addSources" | "removeSource" | "refreshSource" | "relinkSource">;

/** Only management crosses local RPC; model reads stay inside the Runtime owner. */
export function createLocalInformationBasketClient(call: LocalRuntimeCallHandler) {
  const listeners = new Set<() => void>();
  const service: InformationBasketManagement = {
    list: () => call("informationBasket.list", []) as ReturnType<InformationBasketManagement["list"]>,
    updateSettings: (input) => call("informationBasket.updateSettings", [input]) as ReturnType<InformationBasketManagement["updateSettings"]>,
    browseFiles: (input) => call("informationBasket.browseFiles", [input]) as ReturnType<InformationBasketManagement["browseFiles"]>,
    addSources: (input) => call("informationBasket.addSources", [input]) as ReturnType<InformationBasketManagement["addSources"]>,
    removeSource: (input) => call("informationBasket.removeSource", [input]) as ReturnType<InformationBasketManagement["removeSource"]>,
    refreshSource: (input) => call("informationBasket.refreshSource", [input]) as ReturnType<InformationBasketManagement["refreshSource"]>,
    relinkSource: (input) => call("informationBasket.relinkSource", [input]) as ReturnType<InformationBasketManagement["relinkSource"]>,
  };
  return {
    service,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    receive(event: unknown) {
      if (!isInformationBasketChange(event)) return;
      for (const listener of listeners) {
        try { listener(); } catch { /* Observers cannot undo a committed index. */ }
      }
    },
    close() { listeners.clear(); },
  };
}

function isInformationBasketChange(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  return "type" in event && event.type === "information-basket.changed";
}
